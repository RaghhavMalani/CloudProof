'use strict';

// Phase II-A.2 outcome-blind scenario generator.
//
// Phase II-A decided the intended result before sampling anything and then chose
// runtime, traffic, fault template, and schedule shape from that bit, so every
// nuisance statistic became a label proxy. This generator has no notion of an
// outcome: one distribution produces every world and schedule, and only
// deterministic execution in cloud-runtime.js decides what happened.

const { Rng } = require('./simulator');
const {
    balancedPodsPerZone,
    concentratedPodsPerZone,
    defaultNodesPerZone,
    nodeNameList,
    placementConcentration,
    slotsPerNode,
    zoneName,
} = require('../packages/cloudproof/placement');
const { stable } = require('../packages/cloudproof/state');
const { normalizeTopology, topologyId } = require('../packages/cloudproof/topology');
const {
    CLOUD_ACTION,
    CLOUD_FAULT,
    CLOUD_SCHEDULE_SCHEMA_VERSION,
    CONTROLLER_ACTION,
    reindexCloudActions,
    validateCloudSchedule,
} = require('./cloud-actions');

const GENERATOR_ID = 'cloudproof.causal-generator';
const GENERATOR_VERSION = 1;

const DEFAULT_GENERATOR_PARAMETERS = Object.freeze({
    actions: Object.freeze({ minimum: 40, maximum: 140 }),
    // A long forced-calm prefix made "early position implies safe" a shortcut
    // in pilots; the warm-up now only jitters when exogenous events may start.
    warmupActions: Object.freeze({ minimum: 0, maximum: 8 }),
    faultHazard: Object.freeze({ minimum: 0.005, maximum: 0.06 }),
    operationRate: Object.freeze({ minimum: 0.02, maximum: 0.16 }),
    // Traffic is sampled relative to the topology's HPA target rather than from
    // three fixed profiles, so the initial metric is a continuous variable that
    // no longer identifies a generator branch.
    trafficOffsetPercent: Object.freeze({ minimum: -10, maximum: 35 }),
    trafficCpuPercent: Object.freeze({ minimum: 20, maximum: 100 }),
    runtimeMix: Object.freeze({ correct: 1 }),
    placementMix: Object.freeze({ balanced: 0.4, random: 0.3, concentrated: 0.3 }),
    spareNodeProbability: 0.25,
    // A reconcile cycle is one pass of the continuous control loop (deployment,
    // scheduler, settle, endpoints, settle). Without it, random single ticks
    // rarely give a cluster time to heal, and nearly every long schedule fails.
    stepMix: Object.freeze({ controller: 0.55, reconcileCycle: 0.2, advanceTime: 0.25 }),
    settleAfterEndpointsProbability: 0.8,
    settleAfterOperationProbability: 0.6,
    // Settling after an endpoint reconcile must outlast the default 100 ms
    // propagation delay, otherwise the discrete schedule itself manufactures a
    // stale-snapshot race that continuous kube-proxy programming would not.
    settleMs: Object.freeze([150, 250, 400, 600]),
    scaleFloorGuardProbability: 0.85,
    controllerMix: Object.freeze({
        deployment: 0.28, scheduler: 0.24, endpoints: 0.24, kubelet: 0.1, hpa: 0.08, pdb: 0.06,
    }),
    operationMix: Object.freeze({
        scale: 0.3, rollOut: 0.2, rollBack: 0.08, drainNode: 0.14, recoverNode: 0.13, trafficChange: 0.15,
    }),
    faultMix: Object.freeze({
        nodeCrash: 0.32, zoneDegraded: 0.18, readinessDelay: 0.1, imagePullDelay: 0.08,
        hpaStaleMetric: 0.12, endpointPropagationDelay: 0.08, controllerRestart: 0.12,
    }),
    advanceTimeMs: Object.freeze([50, 100, 150, 250, 400, 600, 900, 1300]),
});

const TRAFFIC_REGIMES = Object.freeze(['low', 'normal', 'high']);
const PLACEMENT_KINDS = Object.freeze(['balanced', 'random', 'concentrated']);
const RUNTIMES = Object.freeze(['correct', 'endpoint-includes-unready', 'rollout-ignores-terminating',
    'hpa-stale-indefinitely']);

function streamSeed(seed, name) {
    let hash = (seed >>> 0) || 1;
    for (let index = 0; index < name.length; index += 1) {
        hash ^= name.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash || 1;
}

function mergeParameters(overrides = {}) {
    const merged = {};
    for (const [key, value] of Object.entries(DEFAULT_GENERATOR_PARAMETERS)) {
        const override = overrides[key];
        if (override === undefined) merged[key] = value;
        else if (Array.isArray(value)) merged[key] = override.slice();
        else if (value && typeof value === 'object') merged[key] = { ...value, ...override };
        else merged[key] = override;
    }
    for (const key of Object.keys(overrides)) {
        if (!Object.hasOwn(DEFAULT_GENERATOR_PARAMETERS, key)) throw new TypeError(`unknown generator parameter: ${key}`);
    }
    for (const runtime of Object.keys(merged.runtimeMix)) {
        if (!RUNTIMES.includes(runtime)) throw new TypeError(`unknown runtime in runtimeMix: ${runtime}`);
    }
    return stable(merged);
}

// Weighted choice with keys visited in sorted order, so the same seed yields the
// same pick regardless of how the mix object was written.
function weightedPick(rng, mix) {
    const entries = Object.entries(mix).filter(([, weight]) => weight > 0)
        .sort(([left], [right]) => left.localeCompare(right));
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = rng.float() * total;
    for (const [key, weight] of entries) {
        roll -= weight;
        if (roll < 0) return key;
    }
    return entries[entries.length - 1][0];
}

function trafficRegime(cpuPercent) {
    if (cpuPercent < 45) return 'low';
    if (cpuPercent <= 70) return 'normal';
    return 'high';
}

function sampleCpuPercent(rng, topology, parameters) {
    const offset = rng.range(parameters.trafficOffsetPercent.minimum, parameters.trafficOffsetPercent.maximum);
    return Math.max(parameters.trafficCpuPercent.minimum,
        Math.min(parameters.trafficCpuPercent.maximum, topology.hpaTarget + offset));
}

function trafficFor(cpuPercent, rng) {
    // Latency grows superlinearly with saturation; both carry seeded jitter so
    // the (cpu, latency, rps) triple is not a lookup table of three profiles.
    const latencyMs = Math.round(8 + (cpuPercent * cpuPercent) / 90 + rng.int(6));
    const requestsPerSecond = Math.round(cpuPercent * 4 + rng.int(40));
    return { cpuPercent, latencyMs, requestsPerSecond };
}

function randomPodsPerZone(rng, topology, nodesPerZone) {
    const slots = slotsPerNode(topology);
    const counts = Array.from({ length: topology.zones }, () => 0);
    for (let pod = 0; pod < topology.initialReplicas; pod += 1) {
        const open = counts.map((count, zoneIndex) => (count < nodesPerZone[zoneIndex] * slots ? zoneIndex : -1))
            .filter((zoneIndex) => zoneIndex >= 0);
        counts[open[rng.int(open.length)]] += 1;
    }
    return counts;
}

// Any parameter object that is not the frozen default is re-validated, so a
// key that tries to steer the result can never reach the sampler through a
// caller's options bag.
function checkedParameters(parameters) {
    return parameters === DEFAULT_GENERATOR_PARAMETERS ? parameters : mergeParameters(parameters);
}

function sampleWorld(seed, entry, rawParameters = DEFAULT_GENERATOR_PARAMETERS) {
    const parameters = checkedParameters(rawParameters);
    const rng = new Rng(streamSeed(seed, 'world'));
    const topology = normalizeTopology(entry.topology);
    const runtime = weightedPick(rng, parameters.runtimeMix);
    const cpuPercent = sampleCpuPercent(rng, topology, parameters);
    const traffic = trafficFor(cpuPercent, rng);
    const nodesPerZone = defaultNodesPerZone(topology);
    const spareNodeZone = rng.chance(parameters.spareNodeProbability) ? rng.int(topology.zones) : null;
    if (spareNodeZone !== null) nodesPerZone[spareNodeZone] += 1;
    const placementKind = weightedPick(rng, parameters.placementMix);
    let podsPerZone;
    if (placementKind === 'balanced') podsPerZone = balancedPodsPerZone(topology.initialReplicas, topology.zones);
    else if (placementKind === 'concentrated') {
        podsPerZone = concentratedPodsPerZone(topology, nodesPerZone, rng.int(topology.zones));
    } else podsPerZone = randomPodsPerZone(rng, topology, nodesPerZone);
    const actionCount = rng.range(parameters.actions.minimum, parameters.actions.maximum);
    const warmupActions = Math.min(actionCount, rng.range(parameters.warmupActions.minimum,
        parameters.warmupActions.maximum));
    const hazardSpan = parameters.faultHazard.maximum - parameters.faultHazard.minimum;
    const faultHazard = Number((parameters.faultHazard.minimum + rng.float() * hazardSpan).toFixed(4));
    const operationSpan = parameters.operationRate.maximum - parameters.operationRate.minimum;
    const operationRate = Number((parameters.operationRate.minimum + rng.float() * operationSpan).toFixed(4));
    return stable({
        actionCount,
        faultHazard,
        operationRate,
        placement: { nodesPerZone, podsPerZone },
        placementConcentration: placementConcentration(podsPerZone),
        placementKind,
        runtime,
        spareNodeZone,
        topology,
        topologyId: topologyId(topology),
        traffic,
        trafficRegime: trafficRegime(cpuPercent),
        warmupActions,
    });
}

function operationAction(rng, kind, context) {
    const { topology, nodeNames, versions } = context;
    switch (kind) {
        case 'scale': {
            const delta = rng.pick([-3, -2, -1, 1, 2, 3]);
            // Operators usually respect the service floor; the guard is a
            // probability, not a rule, so scaling below the SLO still occurs.
            const floor = rng.chance(context.parameters.scaleFloorGuardProbability)
                ? Math.max(topology.hpaMinReplicas, topology.serviceMinimumReady)
                : topology.hpaMinReplicas;
            const replicas = Math.max(floor,
                Math.min(topology.hpaMaxReplicas, context.desiredReplicas + delta));
            context.desiredReplicas = replicas;
            return { type: CLOUD_ACTION.SCALE, replicas };
        }
        case 'rollOut':
            versions.current += 1;
            return { type: CLOUD_ACTION.ROLL_OUT, version: `v${versions.current}` };
        case 'rollBack':
            return { type: CLOUD_ACTION.ROLL_BACK };
        case 'drainNode':
            return { type: CLOUD_ACTION.DRAIN_NODE, nodeId: rng.pick(nodeNames) };
        case 'recoverNode':
            return { type: CLOUD_ACTION.RECOVER_NODE, nodeId: rng.pick(nodeNames) };
        case 'trafficChange': {
            const traffic = trafficFor(sampleCpuPercent(rng, topology, context.parameters), rng);
            return { type: CLOUD_ACTION.TRAFFIC_SPIKE, ...traffic };
        }
        default: throw new TypeError(`unknown operation kind: ${kind}`);
    }
}

function faultAction(rng, kind, context) {
    const { topology, nodeNames } = context;
    switch (kind) {
        case 'nodeCrash': return { type: CLOUD_FAULT.NODE_CRASH, nodeId: rng.pick(nodeNames) };
        case 'zoneDegraded': return { type: CLOUD_FAULT.ZONE_DEGRADED, zoneId: zoneName(rng.int(topology.zones)) };
        case 'readinessDelay': return { type: CLOUD_FAULT.READINESS_DELAY, delayMs: rng.pick([0, 300, 600, 900, 1200]) };
        case 'imagePullDelay': return { type: CLOUD_FAULT.IMAGE_PULL_DELAY, delayMs: rng.pick([0, 200, 400, 700, 1000]) };
        case 'hpaStaleMetric': return {
            type: CLOUD_FAULT.HPA_STALE_METRIC,
            metric: Math.max(5, topology.hpaTarget - rng.range(5, 30)),
            durationMs: rng.pick([300, 600, 1200, 2000, 3000]),
        };
        case 'endpointPropagationDelay':
            return { type: CLOUD_FAULT.ENDPOINT_PROPAGATION_DELAY, delayMs: rng.pick([100, 300, 600, 900]) };
        case 'controllerRestart': return {
            type: CLOUD_FAULT.CONTROLLER_RESTART,
            controller: rng.pick(['deployment', 'scheduler', 'kubelet', 'endpoints', 'hpa']),
            durationMs: rng.pick([250, 500, 1000, 2000]),
        };
        default: throw new TypeError(`unknown fault kind: ${kind}`);
    }
}

const CONTROLLER_BY_KIND = Object.freeze({
    deployment: CONTROLLER_ACTION.DEPLOYMENT,
    scheduler: CONTROLLER_ACTION.SCHEDULER,
    endpoints: CONTROLLER_ACTION.ENDPOINTS,
    kubelet: CONTROLLER_ACTION.KUBELET,
    hpa: CONTROLLER_ACTION.HPA,
    pdb: CONTROLLER_ACTION.PDB,
});

/**
 * Samples one action sequence for a world. `options.nodeNames` restricts node
 * targets (counterfactual pairs use the intersection of both worlds' nodes);
 * `options.actionCount`, `options.warmupActions`, and `options.faultHazard`
 * override the world's sampled values for pair continuations.
 */
const SAMPLE_OPTION_KEYS = new Set(['stream', 'nodeNames', 'actionCount', 'warmupActions', 'faultHazard',
    'operationRate']);

function sampleActions(seed, world, rawParameters = DEFAULT_GENERATOR_PARAMETERS, options = {}) {
    const parameters = checkedParameters(rawParameters);
    for (const key of Object.keys(options)) {
        if (!SAMPLE_OPTION_KEYS.has(key)) throw new TypeError(`unknown sampleActions option: ${key}`);
    }
    const rng = new Rng(streamSeed(seed, options.stream || 'schedule'));
    const topology = world.topology;
    const context = {
        topology,
        parameters,
        desiredReplicas: topology.initialReplicas,
        versions: { current: 41 },
        nodeNames: options.nodeNames
            || nodeNameList(topology, world.placement.nodesPerZone).map((item) => item.name),
    };
    const actionCount = options.actionCount ?? world.actionCount;
    const warmupActions = options.warmupActions ?? world.warmupActions;
    const faultHazard = options.faultHazard ?? world.faultHazard;
    const operationRate = options.operationRate ?? world.operationRate;
    const actions = [];
    const settle = () => ({ type: CLOUD_ACTION.ADVANCE_TIME, ms: rng.pick(parameters.settleMs) });
    const reconcileCycle = () => [
        { type: CONTROLLER_ACTION.DEPLOYMENT },
        { type: CONTROLLER_ACTION.SCHEDULER },
        { type: CLOUD_ACTION.ADVANCE_TIME, ms: rng.pick(parameters.advanceTimeMs) },
        { type: CONTROLLER_ACTION.ENDPOINTS },
        settle(),
    ];
    // Faults and operations are per-trajectory hazards sampled by the world, so
    // calm and stormy incidents both exist and neither implies an outcome. The
    // warm-up is a fault-free, operation-free prefix that spreads first
    // incidents across the trajectory instead of piling them at index <= 6.
    while (actions.length < actionCount) {
        const exogenousAllowed = actions.length >= warmupActions;
        let category;
        if (exogenousAllowed && rng.chance(faultHazard)) category = 'fault';
        else if (exogenousAllowed && rng.chance(operationRate)) category = 'operation';
        else category = weightedPick(rng, parameters.stepMix);
        if (category === 'fault') actions.push(faultAction(rng, weightedPick(rng, parameters.faultMix), context));
        else if (category === 'operation') {
            actions.push(operationAction(rng, weightedPick(rng, parameters.operationMix), context));
            if (rng.chance(parameters.settleAfterOperationProbability)) actions.push(...reconcileCycle());
        } else if (category === 'reconcileCycle') {
            actions.push(...reconcileCycle());
        } else if (category === 'advanceTime') {
            actions.push({ type: CLOUD_ACTION.ADVANCE_TIME, ms: rng.pick(parameters.advanceTimeMs) });
        } else {
            const controller = weightedPick(rng, parameters.controllerMix);
            actions.push({ type: CONTROLLER_BY_KIND[controller] });
            if (controller === 'endpoints' && rng.chance(parameters.settleAfterEndpointsProbability)) {
                actions.push(settle());
            }
        }
    }
    return actions;
}

function buildSchedule(seed, world, actions, extra = {}) {
    const schedule = {
        schemaVersion: CLOUD_SCHEDULE_SCHEMA_VERSION,
        kind: 'cloudproof.schedule',
        seed,
        scenario: 'causal',
        runtime: world.runtime,
        strategy: 'causal-corpus',
        actions: reindexCloudActions(actions),
        decisions: { generation: null, generator: `${GENERATOR_ID}@${GENERATOR_VERSION}` },
        topology: world.topology,
        topologyId: world.topologyId,
        scenarioParameters: stable({
            traffic: world.traffic,
            trafficProfile: world.trafficRegime,
            placement: world.placement,
            generator: {
                actionCount: world.actionCount,
                faultHazard: world.faultHazard,
                operationRate: world.operationRate,
                placementKind: world.placementKind,
                spareNodeZone: world.spareNodeZone,
                warmupActions: world.warmupActions,
            },
            ...extra,
        }),
    };
    validateCloudSchedule(schedule);
    return schedule;
}

function materializeCausalSchedule(seed, entry, parameters = DEFAULT_GENERATOR_PARAMETERS) {
    const world = sampleWorld(seed, entry, parameters);
    return { world, schedule: buildSchedule(seed, world, sampleActions(seed, world, parameters)) };
}

module.exports = {
    DEFAULT_GENERATOR_PARAMETERS,
    GENERATOR_ID,
    GENERATOR_VERSION,
    PLACEMENT_KINDS,
    RUNTIMES,
    TRAFFIC_REGIMES,
    buildSchedule,
    checkedParameters,
    materializeCausalSchedule,
    mergeParameters,
    sampleActions,
    sampleWorld,
    streamSeed,
    trafficRegime,
    weightedPick,
};
