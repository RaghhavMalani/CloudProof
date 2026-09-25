'use strict';

// Proposed changes and the controllers that carry them out.
//
// A change is executed by a small deterministic controller that reads the
// current simulator state once per 100 ms tick and emits ordinary CloudProof
// Mesh actions (scale, pod restart, node drain). The mesh engine decides what
// those actions do; the controller only decides when to issue them, the way
// a Deployment controller waits for readiness before replacing the next pod.

const { MESH_ACTION, MESH_FAULT, POD_PHASE, SERVICE_KIND } = require('../cloudproof-mesh/constants');

const CHANGE_TYPES = Object.freeze({
    rollout: { title: 'Roll out version', kinds: [SERVICE_KIND.API, SERVICE_KIND.CACHE, SERVICE_KIND.WORKER] },
    scale: { title: 'Scale service', kinds: [SERVICE_KIND.API, SERVICE_KIND.CACHE, SERVICE_KIND.WORKER, SERVICE_KIND.QUEUE] },
    'drain-node': { title: 'Drain node' },
    'drain-zone': { title: 'Drain zone' },
    'db-failover': { title: 'Fail over database' },
});

const DEFAULT_STRATEGY = Object.freeze({ maxSurge: 1, maxUnavailable: 1 });

function serviceOf(world, id) {
    return world.services.find((item) => item.id === id) || null;
}

function integerIn(value, low, high) {
    return Number.isInteger(value) && value >= low && value <= high;
}

function validateChange(world, change) {
    if (!change || !CHANGE_TYPES[change.type]) throw new TypeError(`unknown change type: ${change?.type}`);
    const fail = (message) => { throw new TypeError(`${change.type}: ${message}`); };
    switch (change.type) {
        case 'rollout': {
            const target = serviceOf(world, change.service);
            if (!target || !CHANGE_TYPES.rollout.kinds.includes(target.kind)) fail('needs an api, cache or worker service');
            if (typeof change.toVersion !== 'string' || !change.toVersion) fail('needs a target version');
            if (!integerIn(change.maxSurge, 0, 64)) fail('maxSurge must be an integer in [0, 64]');
            if (!integerIn(change.maxUnavailable, 0, target.replicas)) fail(`maxUnavailable must be an integer in [0, ${target.replicas}]`);
            if (change.maxSurge === 0 && change.maxUnavailable === 0) fail('maxSurge and maxUnavailable cannot both be 0');
            break;
        }
        case 'scale': {
            const target = serviceOf(world, change.service);
            if (!target || !CHANGE_TYPES.scale.kinds.includes(target.kind)) fail('needs a non-database service');
            if (!integerIn(change.replicas, 1, 64)) fail('replicas must be an integer in [1, 64]');
            if (change.replicas === target.replicas) fail(`${change.service} already runs ${target.replicas} replicas`);
            break;
        }
        case 'drain-node':
            if (!world.nodes.some((node) => node.id === change.node)) fail(`unknown node ${change.node}`);
            break;
        case 'drain-zone':
            if (!world.zones.some((zone) => zone.id === change.zone)) fail(`unknown zone ${change.zone}`);
            if (!integerIn(change.intervalMs, 0, 30_000) || change.intervalMs % 100 !== 0) fail('intervalMs must be a multiple of 100 in [0, 30000]');
            break;
        case 'db-failover': {
            const target = serviceOf(world, change.database);
            if (target?.role !== 'primary') fail('needs a primary database');
            if (!world.dependencies.some((edge) => edge.type === 'REPLICATES' && edge.from === change.database)) {
                fail(`${change.database} has no replica to fail over to`);
            }
            break;
        }
        default:
    }
    return true;
}

function servingCount(state, serviceId) {
    return state.derived.health[serviceId].healthy;
}

function settled(state) {
    return state.pods.every((pod) => pod.phase === POD_PHASE.RUNNING)
        && state.world.services.every((item) => state.derived.health[item.id].healthy >= state.services[item.id].desiredReplicas);
}

function podsOnNodes(world, serviceId) {
    return [...new Set(world.placement[serviceId])];
}

/**
 * A controller emits labelled mesh actions. `next(state)` is called once per
 * tick before time advances; `complete` flips once the change has finished.
 */
function createController(world, change, versions = {}) {
    validateChange(world, change);
    const label = (text) => text;
    switch (change.type) {
        case 'rollout': {
            const target = serviceOf(world, change.service);
            const replicas = target.replicas;
            const from = versions[change.service] || 'current';
            const originals = Array.from({ length: replicas }, (_, index) => `pod/${change.service}-${index + 1}`);
            const restarted = new Set();
            let phase = change.maxSurge > 0 ? 'surge' : 'rolling';
            return {
                get complete() { return phase === 'complete'; },
                next(state) {
                    if (phase === 'surge') {
                        phase = 'rolling';
                        return [{
                            action: { type: MESH_ACTION.SCALE, serviceId: change.service, replicas: replicas + change.maxSurge },
                            label: label(`Rollout adds ${change.maxSurge} surge pod${change.maxSurge > 1 ? 's' : ''} running ${change.toVersion} (${replicas} → ${replicas + change.maxSurge})`),
                            step: 'surge',
                        }];
                    }
                    if (phase !== 'rolling') return [];
                    const remaining = originals.filter((id) => !restarted.has(id));
                    if (!remaining.length) {
                        if (servingCount(state, change.service) < replicas + change.maxSurge) return [];
                        phase = 'complete';
                        if (change.maxSurge === 0) return [];
                        return [{
                            action: { type: MESH_ACTION.SCALE, serviceId: change.service, replicas },
                            label: label(`Rollout finishes: surge removed, ${replicas} pods on ${change.toVersion}`),
                            step: 'finish',
                        }];
                    }
                    const allowed = servingCount(state, change.service) - (replicas - change.maxUnavailable);
                    const batch = remaining.slice(0, Math.max(0, allowed));
                    return batch.map((podId) => {
                        restarted.add(podId);
                        return {
                            action: { type: MESH_FAULT.POD_CRASH, podId },
                            label: label(`Rollout replaces ${podId} (${from} → ${change.toVersion}); it stops serving until the new version is ready`),
                            step: 'replace',
                        };
                    });
                },
            };
        }
        case 'scale': {
            const target = serviceOf(world, change.service);
            let issued = false;
            return {
                get complete() { return issued; },
                next(state) {
                    if (issued) return [];
                    issued = true;
                    return [{
                        action: { type: MESH_ACTION.SCALE, serviceId: change.service, replicas: change.replicas },
                        label: label(`Scale ${change.service} ${target.replicas} → ${change.replicas} replicas`),
                        step: 'scale',
                    }];
                },
            };
        }
        case 'drain-node': {
            let phase = 'drain';
            return {
                get complete() { return phase === 'complete'; },
                next(state) {
                    if (phase === 'drain') {
                        phase = 'waiting';
                        return [{
                            action: { type: MESH_ACTION.DRAIN_NODE, nodeId: change.node },
                            label: label(`Drain ${change.node}: cordon it and evict its pods`),
                            step: 'drain',
                        }];
                    }
                    if (phase === 'waiting' && settled(state)) phase = 'complete';
                    return [];
                },
            };
        }
        case 'drain-zone': {
            const nodes = world.nodes.filter((node) => node.zone === change.zone).map((node) => node.id).sort();
            let index = 0;
            let lastAt = null;
            let phase = 'draining';
            return {
                get complete() { return phase === 'complete'; },
                next(state) {
                    if (phase === 'draining') {
                        if (lastAt !== null && state.clockMs - lastAt < change.intervalMs) return [];
                        const out = [];
                        do {
                            const nodeId = nodes[index];
                            index += 1;
                            out.push({
                                action: { type: MESH_ACTION.DRAIN_NODE, nodeId },
                                label: label(`Drain ${nodeId} (${index}/${nodes.length} in ${change.zone})`),
                                step: 'drain',
                            });
                        } while (change.intervalMs === 0 && index < nodes.length);
                        lastAt = state.clockMs;
                        if (index >= nodes.length) phase = 'waiting';
                        return out;
                    }
                    if (phase === 'waiting' && settled(state)) phase = 'complete';
                    return [];
                },
            };
        }
        case 'db-failover': {
            const nodes = podsOnNodes(world, change.database);
            let phase = 'drain';
            return {
                get complete() { return phase === 'complete'; },
                next(state) {
                    if (phase === 'drain') {
                        phase = 'waiting';
                        return nodes.map((nodeId) => ({
                            action: { type: MESH_ACTION.DRAIN_NODE, nodeId },
                            label: label(`Planned failover: drain ${nodeId}, taking ${change.database} offline so its replica is promoted`),
                            step: 'drain',
                        }));
                    }
                    if (phase === 'waiting' && state.services[change.database].promoted && settled(state)) phase = 'complete';
                    return [];
                },
            };
        }
        default:
            throw new TypeError(`unknown change type: ${change.type}`);
    }
}

/** The service a change acts on, when there is one. */
function changeTarget(change) {
    return change.service || change.database || change.node || change.zone || null;
}

/**
 * Before/after rows for the change diff. `sensitive` marks the rows that
 * reduce available capacity while the change runs.
 */
function describeChange(world, change, versions = {}, strategy = DEFAULT_STRATEGY) {
    validateChange(world, change);
    const rows = [];
    const row = (field, before, after, sensitive = false, note = null) => rows.push({ field, before, after, changed: String(before) !== String(after), sensitive, note });
    let title;
    switch (change.type) {
        case 'rollout': {
            const target = serviceOf(world, change.service);
            title = `${change.service} deployment`;
            row('version', versions[change.service] || 'current', change.toVersion);
            row('replicas', target.replicas, target.replicas);
            row('maxSurge', strategy.maxSurge, change.maxSurge);
            row('maxUnavailable', strategy.maxUnavailable, change.maxUnavailable, change.maxUnavailable > 0,
                change.maxUnavailable > 0 ? `up to ${change.maxUnavailable} of ${target.replicas} pods may be out of service at once` : null);
            row('minHealthy', target.minHealthy, target.minHealthy, target.replicas - change.maxUnavailable < target.minHealthy + 1,
                'serving pods needed for the service to count as up');
            break;
        }
        case 'scale': {
            const target = serviceOf(world, change.service);
            title = `${change.service} replicas`;
            row('replicas', target.replicas, change.replicas, change.replicas < target.replicas,
                change.replicas < target.replicas ? `capacity ${target.replicas * target.podCapacityRps} → ${change.replicas * target.podCapacityRps} rps` : null);
            row('capacity (rps)', target.replicas * target.podCapacityRps, change.replicas * target.podCapacityRps, change.replicas < target.replicas);
            break;
        }
        case 'drain-node': {
            const pods = world.services.flatMap((item) => world.placement[item.id].filter((node) => node === change.node).map(() => item.id));
            title = `${change.node} maintenance`;
            row('schedulable', 'yes', 'no (cordoned)', true);
            row('pods evicted', 0, pods.length, pods.length > 0, [...new Set(pods)].join(', ') || null);
            break;
        }
        case 'drain-zone': {
            const nodes = world.nodes.filter((node) => node.zone === change.zone).map((node) => node.id);
            const pods = world.services.reduce((sum, item) => sum + world.placement[item.id].filter((node) => nodes.includes(node)).length, 0);
            title = `${change.zone} maintenance`;
            row('nodes cordoned', 0, nodes.length, true, nodes.join(', '));
            row('pods evicted', 0, pods, pods > 0);
            row('drain interval', '—', `${(change.intervalMs / 1000).toFixed(1)} s`, change.intervalMs < 1000);
            break;
        }
        case 'db-failover': {
            const replica = world.dependencies.find((edge) => edge.type === 'REPLICATES' && edge.from === change.database).to;
            title = `${change.database} failover`;
            row('write primary', change.database, replica, true, 'promotion happens after the failover delay (1.5 s)');
            row('reads + writes on', `${change.database} + ${replica}`, replica, true, 'the promoted replica serves both');
            break;
        }
        default:
    }
    return { title, type: change.type, typeTitle: CHANGE_TYPES[change.type].title, rows };
}

function changeSummary(change) {
    switch (change.type) {
        case 'rollout': return `Roll out ${change.service} ${change.toVersion} (maxSurge ${change.maxSurge}, maxUnavailable ${change.maxUnavailable})`;
        case 'scale': return `Scale ${change.service} to ${change.replicas} replicas`;
        case 'drain-node': return `Drain ${change.node}`;
        case 'drain-zone': return `Drain ${change.zone}, one node every ${(change.intervalMs / 1000).toFixed(1)} s`;
        case 'db-failover': return `Fail over ${change.database} to its replica`;
        default: return change.type;
    }
}

module.exports = {
    CHANGE_TYPES,
    DEFAULT_STRATEGY,
    changeSummary,
    changeTarget,
    createController,
    describeChange,
    settled,
    validateChange,
};
