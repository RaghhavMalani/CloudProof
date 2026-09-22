'use strict';

// Phase II-A.2 causal corpus: execution, labelling, rows, tiers, pairs.
//
// The pipeline is two passes over one deterministic index space so that the
// label is never known before execution and never influences what is kept:
//   pass 1  generate + execute every trajectory, keep only a nuisance summary
//   match   stratified 1:1 safe/unsafe matching on those summaries
//   pass 2  re-execute the matched trajectories, prove the replay fingerprint
//           is unchanged, and only then emit transition rows.

const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { digest } = require('../packages/agent-runtime');
const { canonicalGraphSerialization } = require('../packages/cloudproof/graph');
const { stable } = require('../packages/cloudproof/state');
const { extractRiskFeatures, heuristicRiskScore } = require('../packages/cloudproof/transition-dataset');
const { TOPOLOGY_CATALOG_V2 } = require('../packages/cloudproof/topology');
const {
    comparePairStates,
    pairDesign,
    variantWorld,
} = require('../packages/cloudproof/counterfactual-pairs');
const {
    ACTION_TYPES,
    CLOUD_ACTION,
    CLOUD_FAULT,
    CONTROLLER_ACTION,
    CONTROLLER_TYPES,
    FAULT_TYPES,
} = require('./cloud-actions');
const { controllerStateSignature } = require('./cloud-schedule');
const {
    buildSchedule,
    materializeCausalSchedule,
    mergeParameters,
    sampleActions,
    sampleWorld,
    streamSeed,
} = require('./cloud-causal-generator');
const { runCloudSchedule } = require('./cloud-runtime');
const { Rng } = require('./simulator');

const CAUSAL_DATASET_SCHEMA_VERSION = 3;
const HORIZONS = Object.freeze([1, 5, 10, 20]);
const DEFAULT_HORIZON = 5;
const SPLITS = Object.freeze(['train', 'validation', 'test', 'ood']);
const FEATURE_BOUNDARY = 'state-and-candidate-action-only';
const EXOGENOUS_TYPES = new Set([...ACTION_TYPES.filter((type) => type !== CLOUD_ACTION.ADVANCE_TIME), ...FAULT_TYPES]);
const TICK_TYPES = new Set([...CONTROLLER_TYPES, CLOUD_ACTION.ADVANCE_TIME]);
const OPERATION_TYPES = new Set(ACTION_TYPES.filter((type) => type !== CLOUD_ACTION.ADVANCE_TIME));

// Research rows: every exogenous decision point, every transition whose
// observable controller state changed, and a seeded fraction of the remaining
// uneventful ticks/timers. The raw simulator trace is never truncated.
const DEFAULT_CHECKPOINT_POLICY = Object.freeze({ tickRate: 0.15, timerRate: 0.1 });
// Half of the pairs are relational-only (identical pooled inputs); the
// placement families remain as the easier, flat-visible controls.
const PAIR_FAMILY_MIX = Object.freeze([
    'zone-placement', 'node-concentration', 'node-placement', 'readiness-wiring',
    'zone-placement', 'node-concentration', 'node-placement', 'readiness-wiring',
    'readiness-drain', 'pdb-placement', 'capacity-distribution', 'readiness-drain',
]);
const DEFAULT_PAIR_POLICY = Object.freeze({
    prefixActions: Object.freeze({ minimum: 4, maximum: 24 }),
    continuationActions: Object.freeze({ minimum: 20, maximum: 60 }),
});

function trajectoryId(seed) {
    return `trajectory-${String(seed).padStart(7, '0')}`;
}

// The candidate action a scorer receives has no schedule position: `id` and
// `atMs` are the Phase II-A channel through which template length leaked.
function candidateAction(action) {
    const { id, atMs, ...rest } = action;
    return stable(rest);
}

function checkpointKind(actionType) {
    if (EXOGENOUS_TYPES.has(actionType)) return 'exogenous';
    if (TICK_TYPES.has(actionType)) return 'tick';
    return 'timer';
}

// A transition is meaningful when the observable cluster state moved: pod
// readiness/pending/terminating, endpoint set size, desired replicas, node
// readiness/draining, rollout or HPA activity, or PDB headroom.
function meaningfulSignature(graph) {
    const deployment = graphFeature(graph, 'Deployment');
    const service = graphFeature(graph, 'Service');
    return `${controllerStateSignature(graph)}|${service.endpointCount}|${deployment.desiredReplicas}`
        + `|${deployment.observed?.running}|${deployment.observed?.terminating}|${deployment.desiredVersion}`;
}

function isMeaningfulTransition(row) {
    return meaningfulSignature(row.state) !== meaningfulSignature(row.nextState);
}

function horizonLabels(sequence, incidentSequence) {
    const labels = {};
    for (const horizon of HORIZONS) {
        labels[String(horizon)] = incidentSequence !== null
            && sequence <= incidentSequence
            && incidentSequence - sequence < horizon;
    }
    return labels;
}

function shortType(type) {
    return type.split('.').pop();
}

function graphFeature(graph, type) {
    return graph.nodes.find((node) => node.type === type)?.features || {};
}

function classifyIncident({ trace, rows, incidentIndex, world }) {
    const entry = trace[incidentIndex];
    const row = rows[incidentIndex];
    const violationClass = entry.failure.violationClass;
    const actionType = entry.action.type;
    const deployment = graphFeature(row.state, 'Deployment');
    const zoneConcentration = extractRiskFeatures(row, row.action)[2];
    let lastExogenous = -1;
    const activeDelays = { readiness: 0, imagePull: 0, propagation: 100 };
    let controllerRestartInWindow = false;
    let hpaScaleInWindow = false;
    for (let index = 0; index < incidentIndex; index += 1) {
        const type = trace[index].action.type;
        if (EXOGENOUS_TYPES.has(type)) lastExogenous = index;
        if (type === CLOUD_FAULT.READINESS_DELAY) activeDelays.readiness = trace[index].action.delayMs ?? 900;
        if (type === CLOUD_FAULT.IMAGE_PULL_DELAY) activeDelays.imagePull = trace[index].action.delayMs ?? 700;
        if (type === CLOUD_FAULT.ENDPOINT_PROPAGATION_DELAY) activeDelays.propagation = trace[index].action.delayMs ?? 800;
        if (type === CLOUD_FAULT.CONTROLLER_RESTART && incidentIndex - index <= 15) controllerRestartInWindow = true;
        if (type === CONTROLLER_ACTION.HPA && trace[index].outcome?.changed && incidentIndex - index <= 15) {
            hpaScaleInWindow = true;
        }
    }
    const transitionsSinceExogenous = lastExogenous === -1 ? incidentIndex + 1 : incidentIndex - lastExogenous;
    const capacityLoss = [CLOUD_FAULT.NODE_CRASH, CLOUD_FAULT.ZONE_DEGRADED, CLOUD_FAULT.NODE_DRAIN,
        CLOUD_ACTION.DRAIN_NODE].includes(actionType);
    // Roughly three reconcile cycles of timers and ticks with no external event.
    const flags = {
        longHorizon: transitionsSinceExogenous >= 20,
        controllerInteraction: ['AUTOSCALER_CAPACITY_MISMATCH', 'PDB_SEMANTICS_VIOLATION'].includes(violationClass)
            || actionType === CONTROLLER_ACTION.HPA
            || hpaScaleInWindow
            || controllerRestartInWindow,
        topology: capacityLoss
            && ['SERVICE_CAPACITY_COLLAPSE', 'ZONE_SURVIVABILITY_VIOLATION'].includes(violationClass)
            && zoneConcentration > 1 / world.topology.zones + 0.15,
        interaction: Boolean(deployment.rolloutActive)
            || ['ROLLOUT_AVAILABILITY_VIOLATION', 'TRAFFIC_TO_UNREADY_POD'].includes(violationClass)
            || activeDelays.readiness > 0
            || activeDelays.imagePull > 0
            || activeDelays.propagation > 100,
    };
    let tier = 1;
    if (flags.longHorizon) tier = 5;
    else if (flags.controllerInteraction) tier = 4;
    else if (flags.topology) tier = 3;
    else if (flags.interaction) tier = 2;
    return stable({ tier, flags, transitionsSinceExogenous, zoneConcentration });
}

function countTypes(actions, filter) {
    const counts = {};
    for (const action of actions) {
        if (!filter(action.type)) continue;
        const key = shortType(action.type);
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

function summarizeTrajectory({ index, seed, entry, world, schedule, result, wallTimeMs }) {
    const rows = result.graphTransitions;
    const trace = result.trace.transitions;
    if (rows.length !== trace.length) throw new Error(`telemetry/trace length mismatch for seed ${seed}`);
    rows.forEach((row, position) => {
        if (row.sequence !== trace[position].sequence) throw new Error(`sequence mismatch for seed ${seed}`);
    });
    const incidentIndex = trace.findIndex((item) => item.failure);
    const incident = incidentIndex === -1 ? null : stable({
        sequence: trace[incidentIndex].sequence,
        atMs: trace[incidentIndex].atMs,
        actionType: trace[incidentIndex].action.type,
        violationClass: trace[incidentIndex].failure.violationClass,
        invariant: trace[incidentIndex].failure.invariant,
        relativePosition: trace[incidentIndex].sequence / trace.length,
    });
    const kinds = rows.map((row) => checkpointKind(row.action.type));
    const meaningful = rows.map(isMeaningfulTransition);
    const initialDeployment = graphFeature(rows[0].state, 'Deployment');
    // Activity summaries are rates over the research window (up to and
    // including the first incident). Counts over the whole trace would carry
    // the post-incident cascade, which is the outcome itself; counts over the
    // window would carry its length, which is also the outcome. Rates over the
    // window carry neither.
    const windowLength = incidentIndex === -1 ? rows.length : incidentIndex + 1;
    const windowRows = rows.slice(0, windowLength);
    const windowTrace = trace.slice(0, windowLength);
    const per100 = (count) => (100 * count) / Math.max(1, windowLength);
    const fraction = (count) => count / Math.max(1, windowLength);
    const summary = {
        trajectoryId: trajectoryId(seed),
        index,
        seed,
        seedBucket: seed % 8,
        scenarioFamily: 'causal',
        split: entry.split,
        topologyId: entry.topologyId,
        topologyLabel: entry.label,
        runtime: world.runtime,
        trafficRegime: world.trafficRegime,
        initialCpuPercent: world.traffic.cpuPercent,
        placementKind: world.placementKind,
        placementConcentration: world.placementConcentration,
        replicas: world.topology.initialReplicas,
        zones: world.topology.zones,
        nodes: world.placement.nodesPerZone.reduce((sum, value) => sum + value, 0),
        actions: schedule.actions.length,
        transitions: rows.length,
        rawTransitionCount: rows.length,
        meaningfulTransitions: meaningful.filter(Boolean).length,
        virtualRuntimeMs: result.finalState.clockMs,
        initialReadyReplicas: initialDeployment.observed?.ready ?? 0,
        initialPendingReplicas: initialDeployment.observed?.pending ?? 0,
        initialPdbHeadroom: world.topology.initialReplicas - world.topology.pdbMinAvailable,
        degradedNodeTransitions: rows.filter((row) => row.state.nodes
            .some((node) => node.type === 'Node' && !node.features.ready)).length,
        warmupActions: world.warmupActions,
        faultHazard: world.faultHazard,
        operationRate: world.operationRate,
        faultCount: schedule.actions.filter((action) => FAULT_TYPES.includes(action.type)).length,
        operationCount: schedule.actions.filter((action) => OPERATION_TYPES.has(action.type)).length,
        controllerTickCount: schedule.actions.filter((action) => CONTROLLER_TYPES.includes(action.type)).length,
        advanceTimeCount: schedule.actions.filter((action) => action.type === CLOUD_ACTION.ADVANCE_TIME).length,
        timerCount: kinds.filter((kind) => kind === 'timer').length,
        timerFraction: fraction(kinds.slice(0, windowLength).filter((kind) => kind === 'timer').length),
        faults: countTypes(schedule.actions, (type) => FAULT_TYPES.includes(type)),
        operations: countTypes(schedule.actions, (type) => OPERATION_TYPES.has(type)),
        hpaScaleEvents: trace.filter((item) => item.action.type === CONTROLLER_ACTION.HPA && item.outcome?.changed).length,
        hpaScaleEventsPer100: per100(windowTrace.filter((item) => (
            item.action.type === CONTROLLER_ACTION.HPA && item.outcome?.changed
        )).length),
        rolloutActiveTransitions: rows.filter((row) => graphFeature(row.state, 'Deployment').rolloutActive).length,
        rolloutActiveFraction: fraction(windowRows.filter((row) => graphFeature(row.state, 'Deployment').rolloutActive).length),
        pdbDecisions: result.finalState.history.disruptions.length,
        pdbDecisionsPer100: per100(windowTrace.reduce((sum, item) => (
            sum + (Array.isArray(item.outcome?.decisions) ? item.outcome.decisions.length : 0)
        ), 0)),
        meaningfulTransitionFraction: fraction(meaningful.slice(0, windowLength).filter(Boolean).length),
        researchWindowTransitions: windowLength,
        outcome: incident ? 'unsafe' : 'safe',
        incident,
        difficulty: incident ? classifyIncident({ trace, rows, incidentIndex, world }) : null,
        replayFingerprint: result.replayFingerprint,
        scheduleDigest: digest(schedule),
        verificationWallTimeMs: wallTimeMs,
    };
    return { summary, rows, trace, incidentIndex, kinds, meaningful };
}

// Outcome-blind row selection: every exogenous decision point and every
// state-changing transition is kept; uneventful ticks and timers by a seeded
// coin that is consumed once per transition whatever the label is. The failing
// transition is deliberately not force-kept: forcing it would make "timer
// action implies positive" a new shortcut.
function selectCheckpoints(seed, kinds, meaningful, policy) {
    const rng = new Rng(streamSeed(seed, 'checkpoint'));
    return kinds.map((kind, position) => {
        const roll = rng.float();
        if (kind === 'exogenous') return 'exogenous';
        if (meaningful[position]) return 'state-change';
        if (kind === 'tick') return roll < policy.tickRate ? 'sampled' : null;
        return roll < policy.timerRate ? 'sampled' : null;
    });
}

function transitionRecord({ row, kind, checkpoint, summary, incidentSequence }) {
    canonicalGraphSerialization(row.state);
    const horizons = horizonLabels(row.sequence, incidentSequence);
    return stable({
        datasetSchemaVersion: CAUSAL_DATASET_SCHEMA_VERSION,
        recordId: `${summary.trajectoryId}:transition-${row.sequence}`,
        trajectoryId: summary.trajectoryId,
        scenarioId: summary.trajectoryId,
        topologyId: summary.topologyId,
        split: summary.split,
        state: row.state,
        action: candidateAction(row.action),
        labels: {
            sloViolationWithinKTransitions: horizons[String(DEFAULT_HORIZON)],
            labelHorizonTransitions: DEFAULT_HORIZON,
            horizons,
            transitionsToIncident: incidentSequence === null ? null : incidentSequence - row.sequence,
            incidentClass: summary.incident?.violationClass || null,
        },
        metadata: {
            sequence: row.sequence,
            atMs: row.atMs,
            transitions: summary.transitions,
            rawTransitionCount: summary.rawTransitionCount,
            researchTransitionCount: summary.researchTransitionCount,
            checkpoint,
            transitionKind: kind,
            replayDigest: summary.replayFingerprint,
            action: { id: row.action.id, atMs: row.action.atMs, source: row.metadata?.source || null },
            nextStateDigest: digest(canonicalGraphSerialization(row.nextState)).slice(0, 32),
            seed: summary.seed,
            topologyLabel: summary.topologyLabel,
            trafficProfile: summary.trafficRegime,
            runtime: summary.runtime,
            placementKind: summary.placementKind,
            trajectoryOutcome: summary.outcome,
            difficultyTier: summary.difficulty?.tier ?? null,
            featureBoundary: FEATURE_BOUNDARY,
        },
    });
}

function compactExample(record, summary) {
    return {
        recordId: record.recordId,
        trajectoryId: record.trajectoryId,
        split: record.split,
        sequence: record.metadata.sequence,
        atMs: record.metadata.atMs,
        transitions: summary.transitions,
        // The HPA's last sample time is the one clock a scorer can read from
        // the state graph; it is probed as a position feature for that reason.
        hpaClockMs: graphFeature(record.state, 'HPA').sampledAtMs ?? 0,
        features: extractRiskFeatures(record, record.action),
        heuristicScore: heuristicRiskScore(record.state, record.action),
        horizons: record.labels.horizons,
        outcome: summary.outcome,
        tier: summary.difficulty?.tier ?? null,
    };
}

function compactCandidate(summary, schedule, rows, result) {
    const seen = new Set();
    const transitions = [];
    for (const row of rows) {
        const signature = controllerStateSignature(row.nextState);
        const key = `${row.action.type}|${signature}`;
        if (seen.has(key)) continue;
        seen.add(key);
        transitions.push({ action: { type: row.action.type }, controllerStateSignature: signature });
    }
    return {
        scenarioId: summary.trajectoryId,
        trajectoryId: summary.trajectoryId,
        split: summary.split,
        topologyId: summary.topologyId,
        tier: summary.difficulty?.tier ?? null,
        // Scoring sees the same position-free candidate actions as training rows.
        schedule: { ...schedule, actions: schedule.actions.map(candidateAction) },
        initialState: rows[0].state,
        verificationWallTimeMs: summary.verificationWallTimeMs,
        result: {
            ok: !summary.incident,
            failure: summary.incident ? { violationClass: summary.incident.violationClass } : null,
            schedule: { actions: schedule.actions.map(candidateAction) },
            graphTransitions: transitions,
        },
    };
}

function normalizeConfig(config = {}) {
    const catalog = config.catalog || TOPOLOGY_CATALOG_V2;
    return {
        seedStart: config.seedStart ?? 90000,
        catalog,
        parameters: mergeParameters(config.parameters || {}),
        checkpoint: { ...DEFAULT_CHECKPOINT_POLICY, ...(config.checkpoint || {}) },
        pairSeedStart: config.pairSeedStart ?? 95000,
        pairPolicy: {
            prefixActions: { ...DEFAULT_PAIR_POLICY.prefixActions, ...(config.pairPolicy?.prefixActions || {}) },
            continuationActions: {
                ...DEFAULT_PAIR_POLICY.continuationActions,
                ...(config.pairPolicy?.continuationActions || {}),
            },
        },
    };
}

async function executeCausalTrajectory(index, rawConfig, wantRows = false) {
    const config = normalizeConfig(rawConfig);
    const entry = config.catalog[index % config.catalog.length];
    const seed = config.seedStart + index;
    const { world, schedule } = materializeCausalSchedule(seed, entry, config.parameters);
    const started = process.hrtime.bigint();
    const result = await runCloudSchedule(schedule, { mutant: world.runtime, horizonTransitions: DEFAULT_HORIZON });
    const wallTimeMs = Number(process.hrtime.bigint() - started) / 1e6;
    const { summary, rows, incidentIndex, kinds, meaningful } = summarizeTrajectory({
        index, seed, entry, world, schedule, result, wallTimeMs,
    });
    const selected = selectCheckpoints(seed, kinds, meaningful, config.checkpoint);
    const incidentSequence = summary.incident ? summary.incident.sequence : null;
    const eligible = rows.map((row, position) => selected[position] !== null
        && (incidentSequence === null || row.sequence <= incidentSequence));
    summary.mlRows = eligible.filter(Boolean).length;
    summary.researchTransitionCount = summary.mlRows;
    summary.preIncidentTransitions = incidentIndex === -1 ? rows.length : incidentIndex + 1;
    summary.postIncidentTransitions = rows.length - summary.preIncidentTransitions;
    summary.checkpointKinds = {
        exogenous: selected.filter((kind, position) => eligible[position] && kind === 'exogenous').length,
        stateChange: selected.filter((kind, position) => eligible[position] && kind === 'state-change').length,
        sampled: selected.filter((kind, position) => eligible[position] && kind === 'sampled').length,
    };
    if (!wantRows) return { summary };
    const records = [];
    const examples = [];
    rows.forEach((row, position) => {
        if (!eligible[position]) return;
        const record = transitionRecord({
            row, kind: kinds[position], checkpoint: selected[position], summary, incidentSequence,
        });
        records.push(JSON.stringify(record));
        examples.push(compactExample(record, summary));
    });
    return {
        summary,
        records,
        examples,
        candidate: compactCandidate(summary, schedule, rows, result),
    };
}

function regenerateSchedule(index, rawConfig) {
    const config = normalizeConfig(rawConfig);
    const entry = config.catalog[index % config.catalog.length];
    const seed = config.seedStart + index;
    return { entry, seed, ...materializeCausalSchedule(seed, entry, config.parameters) };
}

async function executeCounterfactualPair(pairIndex, rawConfig) {
    const config = normalizeConfig(rawConfig);
    const entry = config.catalog[pairIndex % config.catalog.length];
    // Placement families produce most discordant pairs; PDB and capacity
    // families are kept at a lower rate so their (often concordant) truth is
    // still reported.
    const family = PAIR_FAMILY_MIX[Math.floor(pairIndex / config.catalog.length) % PAIR_FAMILY_MIX.length];
    const seed = config.pairSeedStart + pairIndex;
    const base = sampleWorld(seed, entry, config.parameters);
    const design = pairDesign(seed, base, family);
    const rng = new Rng(streamSeed(seed, 'pair-shape'));
    const prefixLength = rng.range(config.pairPolicy.prefixActions.minimum, config.pairPolicy.prefixActions.maximum);
    const continuationLength = rng.range(config.pairPolicy.continuationActions.minimum,
        config.pairPolicy.continuationActions.maximum);
    const worlds = {
        A: variantWorld(base, design.placements.A, design.roles.A),
        B: variantWorld(base, design.placements.B, design.roles.B),
    };
    const shared = { nodeNames: design.sharedNodeNames };
    const prefix = sampleActions(seed, worlds.A, config.parameters, {
        ...shared, stream: 'pair-prefix', actionCount: prefixLength, warmupActions: Infinity,
    });
    const continuation = sampleActions(seed, worlds.A, config.parameters, {
        ...shared, stream: 'pair-continuation', actionCount: continuationLength, warmupActions: 0,
    });
    const actions = [...prefix, design.intervention, ...continuation];
    const interventionId = `cloud-action-${prefix.length + 1}`;
    const pairId = `pair-${String(pairIndex).padStart(5, '0')}`;
    const baseScenarioId = `pair-base-${seed}`;
    // Both members are built from this one action list; the digest is recorded
    // on each member and re-derived from each executed schedule below.
    const sharedExogenousScheduleDigest = digest(actions);
    const scheduleDigests = {};
    const outcome = {};
    const records = {};
    let valid = design.infeasibleReason === null;
    for (const variant of ['A', 'B']) {
        const schedule = buildSchedule(seed, worlds[variant], actions, {
            pair: { pairId, family, variant, role: design.roles[variant], interventionId },
        });
        scheduleDigests[variant] = digest(schedule.actions.map(candidateAction));
        const result = await runCloudSchedule(schedule, { mutant: base.runtime, horizonTransitions: DEFAULT_HORIZON });
        const rows = result.graphTransitions;
        const trace = result.trace.transitions;
        const interventionIndex = rows.findIndex((row) => row.action.id === interventionId);
        const incidentIndex = trace.findIndex((item) => item.failure);
        const incidentSequence = incidentIndex === -1 ? null : trace[incidentIndex].sequence;
        const interventionSequence = rows[interventionIndex].sequence;
        if (incidentSequence !== null && incidentSequence < interventionSequence) valid = false;
        outcome[variant] = {
            unsafe: incidentSequence !== null,
            incident: incidentIndex === -1 ? null : {
                sequence: incidentSequence,
                transitionsAfterIntervention: incidentSequence - interventionSequence,
                violationClass: trace[incidentIndex].failure.violationClass,
                actionType: trace[incidentIndex].action.type,
            },
            horizons: horizonLabels(interventionSequence, incidentSequence),
            replayFingerprint: result.replayFingerprint,
            transitions: rows.length,
            schedule,
        };
        records[variant] = {
            row: rows[interventionIndex],
            interventionSequence,
        };
    }
    const comparison = comparePairStates(records.A.row.state, records.B.row.state);
    // The nine flat risk features (ready/pending replicas, zone concentration,
    // CPU pressure, rollout/HPA flags, PDB headroom, degraded nodes, action
    // risk) are what the heuristic and logistic baselines see. Relational-only
    // families must leave them identical.
    const flatSummaryIdentical = JSON.stringify(extractRiskFeatures(records.A.row, design.intervention))
        === JSON.stringify(extractRiskFeatures(records.B.row, design.intervention));
    const truth = {
        A: { unsafe: outcome.A.unsafe, horizons: outcome.A.horizons, incident: outcome.A.incident },
        B: { unsafe: outcome.B.unsafe, horizons: outcome.B.horizons, incident: outcome.B.incident },
    };
    if (scheduleDigests.A !== scheduleDigests.B) throw new Error(`pair ${pairId} members diverged in exogenous schedule`);
    const discordant = valid && outcome.A.unsafe !== outcome.B.unsafe;
    const outcomeChange = !valid ? 'invalid'
        : !discordant ? 'same'
            : outcome.B.unsafe ? 'safe->unsafe' : 'unsafe->safe';
    const summary = stable({
        pairId,
        pairIndex,
        baseScenarioId,
        seed,
        family,
        interventionType: family,
        relationalOnly: design.relationalOnly,
        infeasibleReason: design.infeasibleReason,
        pooledInputsIdentical: comparison.pooledInputsIdentical,
        flatSummaryIdentical,
        sharedExogenousScheduleDigest,
        executedScheduleDigest: scheduleDigests.A,
        controlTopology: { topologyId: entry.topologyId, placement: design.placements.A, role: design.roles.A },
        treatedTopology: { topologyId: entry.topologyId, placement: design.placements.B, role: design.roles.B },
        controlOutcome: outcome.A.unsafe ? 'unsafe' : 'safe',
        treatedOutcome: outcome.B.unsafe ? 'unsafe' : 'safe',
        controlFailureClass: outcome.A.incident?.violationClass || null,
        treatedFailureClass: outcome.B.incident?.violationClass || null,
        outcomeChanged: discordant,
        outcomeChange,
        aggregateFeatureDelta: comparison.aggregateFeatureDelta,
        graphStructuralDelta: comparison.graphStructuralDelta,
        split: entry.split,
        topologyId: entry.topologyId,
        topologyLabel: entry.label,
        runtime: base.runtime,
        targetZone: design.targetZone,
        intervention: design.intervention,
        roles: design.roles,
        placements: design.placements,
        prefixActions: prefix.length,
        continuationActions: continuation.length,
        valid,
        discordant,
        riskierVariant: discordant ? (outcome.B.unsafe ? 'B' : 'A') : null,
        horizonDiscordant: valid && outcome.A.horizons['5'] !== outcome.B.horizons['5'],
        aggregateMatched: comparison.aggregateMatched,
        differingEdgeTypes: comparison.differingEdgeTypes,
        truth,
        replayFingerprints: { A: outcome.A.replayFingerprint, B: outcome.B.replayFingerprint },
    });
    const lines = [];
    const scored = {};
    for (const variant of ['A', 'B']) {
        const row = records[variant].row;
        const record = stable({
            datasetSchemaVersion: CAUSAL_DATASET_SCHEMA_VERSION,
            recordId: `${pairId}:${variant}`,
            pairId,
            baseScenarioId,
            variant,
            arm: variant === 'A' ? 'control' : 'treated',
            role: design.roles[variant],
            family,
            interventionType: family,
            relationalOnly: design.relationalOnly,
            sharedExogenousScheduleDigest,
            split: entry.split,
            topologyId: entry.topologyId,
            state: row.state,
            action: candidateAction(row.action),
            labels: {
                sloViolationWithinKTransitions: outcome[variant].horizons[String(DEFAULT_HORIZON)],
                labelHorizonTransitions: DEFAULT_HORIZON,
                horizons: outcome[variant].horizons,
                trajectoryUnsafe: outcome[variant].unsafe,
                incidentClass: outcome[variant].incident?.violationClass || null,
            },
            metadata: {
                seed,
                interventionSequence: records[variant].interventionSequence,
                valid,
                discordant,
                outcomeChange,
                pooledInputsIdentical: comparison.pooledInputsIdentical,
                flatSummaryIdentical,
                aggregateMatched: comparison.aggregateMatched,
                aggregateFeatureDelta: comparison.aggregateFeatureDelta,
                graphStructuralDelta: comparison.graphStructuralDelta,
                placement: design.placements[variant],
                replayDigest: outcome[variant].replayFingerprint,
                featureBoundary: FEATURE_BOUNDARY,
            },
            schedule: outcome[variant].schedule,
        });
        lines.push(JSON.stringify(record));
        scored[variant] = {
            features: extractRiskFeatures(record, record.action),
            heuristicScore: heuristicRiskScore(record.state, record.action),
        };
    }
    return { summary: { ...summary, records: scored }, lines };
}

/**
 * Runs `task` over `indices` on a pool of worker threads and delivers results
 * strictly in index order, so file output is byte-identical whatever the
 * thread count. With one worker everything runs in-process.
 */
async function runPool({ indices, task, config, wantRows = false, workers = 1, chunkSize = 16, onResult, onProgress }) {
    const inline = async (index) => (task === 'pair'
        ? executeCounterfactualPair(index, config)
        : executeCausalTrajectory(index, config, wantRows));
    if (workers <= 1 || indices.length <= chunkSize) {
        for (let position = 0; position < indices.length; position += 1) {
            await onResult(indices[position], await inline(indices[position]));
            if (onProgress && (position + 1) % 250 === 0) onProgress(position + 1, indices.length);
        }
        return;
    }
    const chunks = [];
    for (let start = 0; start < indices.length; start += chunkSize) chunks.push(indices.slice(start, start + chunkSize));
    const pending = new Map();
    let nextChunk = 0;
    let nextFlush = 0;
    let completed = 0;
    const pool = Array.from({ length: Math.min(workers, chunks.length) }, () => new Worker(
        path.join(__dirname, 'cloud-causal-worker.js'), { workerData: { config, wantRows, task } },
    ));
    await new Promise((resolve, reject) => {
        let flushing = Promise.resolve();
        const flush = () => {
            flushing = flushing.then(async () => {
                while (pending.has(nextFlush)) {
                    const { chunk, results } = pending.get(nextFlush);
                    pending.delete(nextFlush);
                    for (let position = 0; position < chunk.length; position += 1) {
                        await onResult(chunk[position], results[position]);
                    }
                    completed += chunk.length;
                    if (onProgress && Math.floor(completed / 250) !== Math.floor((completed - chunk.length) / 250)) {
                        onProgress(completed, indices.length);
                    }
                    nextFlush += 1;
                }
                if (nextFlush === chunks.length) resolve();
            }).catch(reject);
        };
        const dispatch = (worker) => {
            if (nextChunk >= chunks.length) { worker.terminate(); return; }
            const chunkId = nextChunk;
            nextChunk += 1;
            worker.postMessage({ chunkId, indices: chunks[chunkId] });
        };
        for (const worker of pool) {
            worker.on('message', (message) => {
                if (message.error) { reject(new Error(message.error)); return; }
                pending.set(message.chunkId, { chunk: chunks[message.chunkId], results: message.results });
                flush();
                dispatch(worker);
            });
            worker.on('error', reject);
            dispatch(worker);
        }
    });
    await Promise.all(pool.map((worker) => worker.terminate()));
}

function defaultWorkers() {
    return Math.max(1, Math.min(16, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1));
}

module.exports = {
    CAUSAL_DATASET_SCHEMA_VERSION,
    DEFAULT_CHECKPOINT_POLICY,
    DEFAULT_HORIZON,
    DEFAULT_PAIR_POLICY,
    FEATURE_BOUNDARY,
    PAIR_FAMILY_MIX,
    HORIZONS,
    SPLITS,
    candidateAction,
    checkpointKind,
    classifyIncident,
    defaultWorkers,
    executeCausalTrajectory,
    executeCounterfactualPair,
    horizonLabels,
    isMeaningfulTransition,
    meaningfulSignature,
    normalizeConfig,
    regenerateSchedule,
    runPool,
    selectCheckpoints,
    trajectoryId,
    transitionRecord,
};
