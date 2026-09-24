'use strict';

// Deterministic CloudProof Mesh engine (CLOUDPROOF-PHASE-III-MULTISERVICE.md,
// sections 3.3-3.5). Every function is a pure function of the state and the
// action; there is no wall clock and no unseeded randomness.

const {
    CACHE_MISS_RATIO,
    INCIDENT_CLASS,
    MESH_ACTION,
    MESH_FAULT,
    POD_PHASE,
    RELATION,
    SERVICE_KIND,
    SLO_INVARIANT,
    TIMING,
} = require('./constants');
const {
    backingOf,
    clone,
    computeLoads,
    flowOrder,
    incoming,
    outgoing,
    primaryOf,
    replicaOf,
    stable,
    validateWorld,
} = require('./world');

const STATE_KIND = 'cloudproof.mesh-state';

function serviceMap(world) {
    return new Map(world.services.map((service) => [service.id, service]));
}

function nodeReady(state, nodeId) {
    const node = state.world.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return false;
    return !state.nodes[nodeId].crashed && !state.zones[node.zone].degraded;
}

function volumeAvailable(state, volumeId) {
    const volume = state.world.volumes.find((candidate) => candidate.id === volumeId);
    return Boolean(volume) && !state.zones[volume.zone].degraded;
}

function podServing(state, pod) {
    if (pod.phase !== POD_PHASE.RUNNING || !pod.node || !nodeReady(state, pod.node)) return false;
    const service = state.world.services.find((candidate) => candidate.id === pod.service);
    return !service.volume || volumeAvailable(state, service.volume);
}

function podOrdinal(pod) {
    return Number(pod.id.slice(pod.id.lastIndexOf('-') + 1));
}

function createMeshState(world) {
    validateWorld(world);
    const pods = [];
    for (const service of world.services.slice().sort((left, right) => left.id.localeCompare(right.id))) {
        world.placement[service.id].forEach((nodeId, index) => pods.push({
            id: `pod/${service.id}-${index + 1}`,
            service: service.id,
            node: nodeId,
            phase: POD_PHASE.RUNNING,
            readyAtMs: 0,
            restartAtMs: null,
            unavailableSinceMs: null,
        }));
    }
    const state = {
        schemaVersion: 1,
        kind: STATE_KIND,
        world: stable(clone(world)),
        clockMs: 0,
        rps: world.traffic.rps,
        zones: Object.fromEntries(world.zones.map((zone) => [zone.id, { degraded: false }])),
        nodes: Object.fromEntries(world.nodes.map((node) => [node.id, { crashed: false, cordoned: false }])),
        pods,
        services: Object.fromEntries(world.services.map((service) => [service.id, {
            desiredReplicas: service.replicas,
            nextOrdinal: service.replicas + 1,
            coldUntilMs: 0,
            coldOnRecovery: false,
            stalledUntilMs: 0,
            backlog: 0,
            downSinceMs: null,
            promoted: false,
        }])),
        derived: null,
    };
    propagate(state);
    return state;
}

// Section 3.3 rules 3-10, evaluated on the current state.
function propagate(state) {
    const world = state.world;
    const now = state.clockMs;
    const services = serviceMap(world);
    const health = {};
    for (const service of world.services) {
        const pods = state.pods.filter((pod) => pod.service === service.id);
        const healthy = pods.filter((pod) => podServing(state, pod)).length;
        const intrinsicUp = healthy >= service.minHealthy;
        const storageDown = Boolean(service.volume) && !volumeAvailable(state, service.volume);
        health[service.id] = {
            healthy,
            capacityRps: healthy * service.podCapacityRps,
            intrinsicUp,
            reason: intrinsicUp ? null
                : storageDown ? INCIDENT_CLASS.STORAGE_UNAVAILABLE : INCIDENT_CLASS.INSTANCE_LOSS,
        };
    }
    const intrinsicUp = (id) => health[id].intrinsicUp;
    const promoted = (id) => {
        const replica = replicaOf(world, id);
        return state.services[id].promoted && replica ? replica : id;
    };
    const readTarget = (id) => {
        const target = promoted(id);
        if (intrinsicUp(target) || services.get(target).role !== 'replica') return target;
        const primary = primaryOf(world, target);
        return primary && intrinsicUp(promoted(primary)) ? promoted(primary) : target;
    };
    const cold = (id) => state.services[id].coldUntilMs > now;
    const missRatio = (id) => (cold(id) ? CACHE_MISS_RATIO.cold : CACHE_MISS_RATIO.warm);
    const consuming = (id) => intrinsicUp(id) && state.services[id].stalledUntilMs <= now;
    const { load, inflow } = computeLoads(world, {
        intrinsicUp, missRatio, writeTarget: promoted, readTarget, consuming, rps: state.rps,
    });

    const up = {};
    const cause = {};
    for (const service of world.services) {
        const item = health[service.id];
        const overloaded = item.intrinsicUp && load[service.id] > item.capacityRps + 1e-9;
        item.overloaded = overloaded;
        up[service.id] = item.intrinsicUp && !overloaded;
        if (!item.intrinsicUp) cause[service.id] = { kind: 'intrinsic', class: item.reason };
        else if (overloaded) {
            const stampede = world.services.some((cache) => (
                cache.kind === SERVICE_KIND.CACHE
                && promoted(backingOf(world, cache.id)) === service.id
                && (cold(cache.id) || !intrinsicUp(cache.id))
            ));
            cause[service.id] = { kind: 'intrinsic',
                class: stampede ? INCIDENT_CLASS.CACHE_STAMPEDE : INCIDENT_CLASS.OVERLOAD };
        }
    }
    const queueFull = (id) => state.services[id].backlog >= services.get(id).queueCapacity;
    const reverse = flowOrder(world).reverse();
    let changed = true;
    while (changed) {
        changed = false;
        for (const id of reverse) {
            if (!up[id]) continue;
            let failure = null;
            for (const edge of outgoing(world, id)) {
                if (edge.type === RELATION.CALLS && !up[edge.to]) failure = { kind: 'dependency', via: edge.to };
                else if (edge.type === RELATION.WRITES && !up[promoted(edge.to)]) {
                    failure = { kind: 'dependency', via: promoted(edge.to) };
                } else if (edge.type === RELATION.READS) {
                    const target = promoted(edge.to);
                    const primary = services.get(target).role === 'replica' ? primaryOf(world, target) : null;
                    if (!up[target] && !(primary && up[promoted(primary)])) failure = { kind: 'dependency', via: target };
                } else if (edge.type === RELATION.READS_THROUGH && !up[edge.to]) {
                    const backing = promoted(backingOf(world, edge.to));
                    if (!up[backing]) failure = { kind: 'dependency', via: backing };
                } else if (edge.type === RELATION.PUBLISHES) {
                    if (!up[edge.to]) failure = { kind: 'dependency', via: edge.to };
                    else if (queueFull(edge.to)) failure = { kind: 'backpressure', via: edge.to };
                }
                if (failure) break;
            }
            if (failure) {
                up[id] = false;
                cause[id] = failure;
                changed = true;
            }
        }
    }
    const rootOf = (id) => {
        const seen = new Set();
        let current = id;
        while (!seen.has(current)) {
            seen.add(current);
            const item = cause[current];
            if (item.kind === 'intrinsic') return { service: current, class: item.class };
            if (item.kind === 'backpressure') return { service: item.via, class: INCIDENT_CLASS.QUEUE_BACKPRESSURE };
            current = item.via;
        }
        return { service: current, class: INCIDENT_CLASS.INSTANCE_LOSS };
    };
    const routes = Object.fromEntries(world.routes.map((route) => [route.id, { failing: !up[route.entry] }]));
    const failing = world.routes.filter((route) => routes[route.id].failing);
    const errorSharePct = failing.reduce((sum, route) => sum + route.sharePct, 0);
    const violating = errorSharePct > world.errorBudgetPct;
    let incident = null;
    if (violating) {
        const worst = failing.slice().sort((left, right) => (
            right.sharePct - left.sharePct || left.id.localeCompare(right.id)
        ))[0];
        const root = rootOf(worst.entry);
        incident = { route: worst.id, rootService: root.service, incidentClass: root.class };
    }
    state.derived = stable({
        health: Object.fromEntries(Object.entries(health).map(([id, item]) => [id, {
            ...item, up: up[id], load: load[id], cause: cause[id] || null,
        }])),
        inflow,
        queueFull: Object.fromEntries(world.services
            .filter((service) => service.kind === SERVICE_KIND.QUEUE)
            .map((service) => [service.id, queueFull(service.id)])),
        routes,
        errorSharePct,
        violating,
        incident,
    });
    return state;
}

function violationRecord(state) {
    if (!state.derived.violating) return null;
    return stable({
        invariant: SLO_INVARIANT,
        atMs: state.clockMs,
        errorSharePct: state.derived.errorSharePct,
        failingRoutes: Object.entries(state.derived.routes).filter(([, item]) => item.failing).map(([id]) => id).sort(),
        incidentClass: state.derived.incident.incidentClass,
        rootService: state.derived.incident.rootService,
        route: state.derived.incident.route,
    });
}

function failPod(pod, now, keepNode = false) {
    pod.phase = POD_PHASE.FAILED;
    if (!keepNode) pod.node = null;
    pod.restartAtMs = now + TIMING.rescheduleDelayMs;
    pod.unavailableSinceMs = null;
}

function schedulePending(state) {
    const now = state.clockMs;
    const services = serviceMap(state.world);
    const pending = state.pods.filter((pod) => pod.phase === POD_PHASE.PENDING)
        .sort((left, right) => left.id.localeCompare(right.id));
    for (const pod of pending) {
        const service = services.get(pod.service);
        const volumeZone = service.volume
            ? state.world.volumes.find((volume) => volume.id === service.volume).zone : null;
        // A crashed pod keeps its node (and its slot) until it restarts there.
        const usage = new Map();
        for (const other of state.pods) {
            if (other.node) usage.set(other.node, (usage.get(other.node) || 0) + 1);
        }
        const candidates = state.world.nodes.filter((node) => (
            nodeReady(state, node.id)
            && !state.nodes[node.id].cordoned
            && (usage.get(node.id) || 0) < node.slots
            && (!volumeZone || node.zone === volumeZone)
        )).sort((left, right) => (
            (usage.get(left.id) || 0) - (usage.get(right.id) || 0) || left.id.localeCompare(right.id)
        ));
        if (!candidates.length) continue;
        pod.node = candidates[0].id;
        pod.phase = POD_PHASE.STARTING;
        pod.readyAtMs = now + service.startupMs;
        pod.restartAtMs = null;
    }
}

// One 100 ms tick: controllers in the fixed order of section 3.4, then
// propagation. The SLO is checked by the caller after every tick.
function tick(state) {
    state.clockMs += TIMING.tickMs;
    const now = state.clockMs;
    const services = serviceMap(state.world);
    const previous = state.derived;
    for (const pod of state.pods) {
        if (!pod.node || ![POD_PHASE.RUNNING, POD_PHASE.STARTING].includes(pod.phase)) continue;
        if (nodeReady(state, pod.node)) { pod.unavailableSinceMs = null; continue; }
        if (pod.unavailableSinceMs === null) pod.unavailableSinceMs = now;
        if (now - pod.unavailableSinceMs >= TIMING.evictionDelayMs) failPod(pod, now);
    }
    for (const pod of state.pods) {
        if (pod.phase !== POD_PHASE.FAILED || pod.restartAtMs === null || pod.restartAtMs > now) continue;
        if (pod.node && nodeReady(state, pod.node)) {
            pod.phase = POD_PHASE.STARTING;
            pod.readyAtMs = now + services.get(pod.service).startupMs;
            pod.restartAtMs = null;
        } else {
            pod.phase = POD_PHASE.PENDING;
            pod.node = null;
        }
    }
    schedulePending(state);
    for (const pod of state.pods) {
        if (pod.phase === POD_PHASE.STARTING && pod.readyAtMs <= now && nodeReady(state, pod.node)) {
            pod.phase = POD_PHASE.RUNNING;
        }
    }
    for (const service of state.world.services) {
        const runtime = state.services[service.id];
        const intrinsicUp = previous.health[service.id].intrinsicUp;
        if (service.role === 'primary') {
            const replica = replicaOf(state.world, service.id);
            if (intrinsicUp) runtime.downSinceMs = null;
            else if (runtime.downSinceMs === null) runtime.downSinceMs = now;
            if (replica && !runtime.promoted && !intrinsicUp
                && now - runtime.downSinceMs >= TIMING.failoverDelayMs
                && previous.health[replica].intrinsicUp) {
                runtime.promoted = true;
            }
        }
        if (service.kind === SERVICE_KIND.CACHE) {
            if (!intrinsicUp) runtime.coldOnRecovery = true;
            else if (runtime.coldOnRecovery) {
                runtime.coldUntilMs = Math.max(runtime.coldUntilMs, now + TIMING.cacheWarmupMs);
                runtime.coldOnRecovery = false;
            }
        }
        if (service.kind === SERVICE_KIND.QUEUE) {
            const drain = incoming(state.world, service.id, RELATION.CONSUMES)
                .map((edge) => edge.from)
                .filter((id) => previous.health[id].intrinsicUp && state.services[id].stalledUntilMs <= now)
                .reduce((sum, id) => sum + previous.health[id].capacityRps, 0);
            const arriving = intrinsicUp ? (previous.inflow[service.id] || 0) : 0;
            runtime.backlog = Math.max(0, runtime.backlog + (arriving - drain) * (TIMING.tickMs / 1000));
        }
    }
    return propagate(state);
}

function requireTarget(collection, id, label) {
    if (!Object.prototype.hasOwnProperty.call(collection, id)) throw new TypeError(`unknown ${label}: ${id}`);
}

function applyInstant(state, action) {
    const now = state.clockMs;
    const services = serviceMap(state.world);
    switch (action.type) {
        case MESH_ACTION.SCALE: {
            requireTarget(state.services, action.serviceId, 'service');
            if (!Number.isInteger(action.replicas) || action.replicas < 1 || action.replicas > 64) {
                throw new TypeError('scale replicas must be an integer in [1, 64]');
            }
            const runtime = state.services[action.serviceId];
            const pods = state.pods.filter((pod) => pod.service === action.serviceId)
                .sort((left, right) => podOrdinal(left) - podOrdinal(right));
            if (action.replicas > pods.length) {
                for (let count = pods.length; count < action.replicas; count += 1) {
                    state.pods.push({
                        id: `pod/${action.serviceId}-${runtime.nextOrdinal}`,
                        service: action.serviceId,
                        node: null,
                        phase: POD_PHASE.PENDING,
                        readyAtMs: null,
                        restartAtMs: null,
                        unavailableSinceMs: null,
                    });
                    runtime.nextOrdinal += 1;
                }
            } else {
                const removed = new Set(pods.slice(action.replicas).map((pod) => pod.id));
                state.pods = state.pods.filter((pod) => !removed.has(pod.id));
            }
            runtime.desiredReplicas = action.replicas;
            break;
        }
        case MESH_ACTION.TRAFFIC_SHIFT:
            if (!(action.rps > 0)) throw new TypeError('traffic-shift rps must be positive');
            state.rps = action.rps;
            break;
        case MESH_FAULT.TRAFFIC_SPIKE:
            if (!(action.factor > 0)) throw new TypeError('traffic-spike factor must be positive');
            state.rps = Math.round(state.rps * action.factor);
            break;
        case MESH_ACTION.DRAIN_NODE:
            requireTarget(state.nodes, action.nodeId, 'node');
            state.nodes[action.nodeId].cordoned = true;
            state.pods.filter((pod) => pod.node === action.nodeId && pod.phase !== POD_PHASE.FAILED)
                .forEach((pod) => failPod(pod, now));
            break;
        case MESH_ACTION.UNCORDON_NODE:
            requireTarget(state.nodes, action.nodeId, 'node');
            state.nodes[action.nodeId].cordoned = false;
            break;
        case MESH_ACTION.RECOVER_NODE:
            requireTarget(state.nodes, action.nodeId, 'node');
            state.nodes[action.nodeId].crashed = false;
            break;
        case MESH_ACTION.RECOVER_ZONE:
            requireTarget(state.zones, action.zoneId, 'zone');
            state.zones[action.zoneId].degraded = false;
            break;
        case MESH_FAULT.NODE_CRASH:
            requireTarget(state.nodes, action.nodeId, 'node');
            state.nodes[action.nodeId].crashed = true;
            state.pods.filter((pod) => pod.node === action.nodeId).forEach((pod) => failPod(pod, now));
            break;
        case MESH_FAULT.ZONE_DEGRADED:
            requireTarget(state.zones, action.zoneId, 'zone');
            state.zones[action.zoneId].degraded = true;
            break;
        case MESH_FAULT.POD_CRASH: {
            // A fault aimed at a pod that a scale-down already removed hits nothing.
            if (typeof action.podId !== 'string') throw new TypeError('pod-crash needs a podId');
            const pod = state.pods.find((candidate) => candidate.id === action.podId);
            if (pod && pod.phase !== POD_PHASE.PENDING) failPod(pod, now, true);
            break;
        }
        case MESH_FAULT.CACHE_FLUSH:
            requireTarget(state.services, action.serviceId, 'service');
            if (services.get(action.serviceId).kind !== SERVICE_KIND.CACHE) throw new TypeError('cache-flush needs a cache');
            state.services[action.serviceId].coldUntilMs = now + TIMING.cacheWarmupMs;
            break;
        case MESH_FAULT.CONSUMER_STALL:
            requireTarget(state.services, action.serviceId, 'service');
            if (services.get(action.serviceId).kind !== SERVICE_KIND.WORKER) throw new TypeError('consumer-stall needs a worker');
            if (!Number.isInteger(action.durationMs) || action.durationMs < 1) throw new TypeError('durationMs must be positive');
            state.services[action.serviceId].stalledUntilMs = now + action.durationMs;
            break;
        default:
            throw new TypeError(`unknown mesh action: ${action.type}`);
    }
    return propagate(state);
}

/**
 * Apply one schedule action and report the first SLO violation it causes.
 * advance-time runs whole ticks and checks the SLO after each of them.
 */
function step(state, action) {
    const next = clone(state);
    if (action.type === MESH_ACTION.ADVANCE_TIME) {
        if (!Number.isInteger(action.ms) || action.ms < TIMING.tickMs || action.ms % TIMING.tickMs !== 0 || action.ms > 60_000) {
            throw new TypeError(`advance-time ms must be a multiple of ${TIMING.tickMs} in [${TIMING.tickMs}, 60000]`);
        }
        let violation = null;
        for (let elapsed = 0; elapsed < action.ms; elapsed += TIMING.tickMs) {
            tick(next);
            violation = violation || violationRecord(next);
        }
        return { state: next, violation };
    }
    applyInstant(next, action);
    return { state: next, violation: violationRecord(next) };
}

module.exports = {
    STATE_KIND,
    createMeshState,
    nodeReady,
    podServing,
    propagate,
    step,
    tick,
    violationRecord,
    volumeAvailable,
};
