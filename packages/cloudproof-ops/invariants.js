'use strict';

// Modeled invariants for the Operations Console.
//
// An invariant here is an observation of state the CloudProof Mesh engine has
// already computed (`state.derived`, `state.services`, `state.pods`). None of
// them changes what the simulator does; they only decide which simulated
// moments count as violations. The engine's own SLO (route error budget, fixed
// at 20% by the Phase III world) is the default `error-budget` invariant.

const { replicaOf } = require('../cloudproof-mesh/world');

const INVARIANT_KINDS = Object.freeze({
    'route-available': {
        title: 'Critical route available',
        parameters: [{ key: 'route', label: 'Route', type: 'route' }],
        source: 'state.derived.routes[route].failing',
    },
    'error-budget': {
        title: 'Route error budget preserved',
        parameters: [{ key: 'maxPct', label: 'Max failing traffic', type: 'number', unit: '%', min: 0, max: 100, step: 1 }],
        source: 'state.derived.errorSharePct',
    },
    'min-healthy': {
        title: 'Minimum healthy replicas',
        parameters: [
            { key: 'service', label: 'Service', type: 'service' },
            { key: 'min', label: 'Min healthy pods', type: 'number', min: 1, max: 64, step: 1 },
        ],
        source: 'state.derived.health[service].healthy',
    },
    'queue-backlog': {
        title: 'Queue backlog below limit',
        parameters: [
            { key: 'queue', label: 'Queue', type: 'queue' },
            { key: 'max', label: 'Max backlog', type: 'number', unit: 'msgs', min: 1, max: 1_000_000, step: 50 },
        ],
        source: 'state.services[queue].backlog',
    },
    'failover-deadline': {
        title: 'Database write path restored in time',
        parameters: [
            { key: 'database', label: 'Primary database', type: 'primary' },
            { key: 'maxMs', label: 'Deadline', type: 'number', unit: 'ms', min: 100, max: 60_000, step: 100 },
        ],
        source: 'state.derived.health[writeTarget].up, state.services[database].promoted',
    },
});

function describeInvariant(invariant, labels = {}) {
    const name = (id) => labels[id] || id;
    switch (invariant.kind) {
        case 'route-available': return `${invariant.route} route stays available`;
        case 'error-budget': return `failing traffic share ≤ ${invariant.maxPct}%`;
        case 'min-healthy': return `${name(invariant.service)} healthy pods ≥ ${invariant.min}`;
        case 'queue-backlog': return `${name(invariant.queue)} backlog ≤ ${invariant.max} messages`;
        case 'failover-deadline': return `${name(invariant.database)} writes restored within ${(invariant.maxMs / 1000).toFixed(1)} s`;
        default: return invariant.kind;
    }
}

function requireKnown(world, invariant) {
    const services = new Map(world.services.map((item) => [item.id, item]));
    const fail = (message) => { throw new TypeError(`invariant ${invariant.id}: ${message}`); };
    if (!INVARIANT_KINDS[invariant.kind]) fail(`unknown kind ${invariant.kind}`);
    const number = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
    switch (invariant.kind) {
        case 'route-available':
            if (!world.routes.some((route) => route.id === invariant.route)) fail(`unknown route ${invariant.route}`);
            break;
        case 'error-budget':
            if (!number(invariant.maxPct, 0, 100)) fail('maxPct must be within [0, 100]');
            break;
        case 'min-healthy':
            if (!services.has(invariant.service)) fail(`unknown service ${invariant.service}`);
            if (!Number.isInteger(invariant.min) || invariant.min < 1) fail('min must be a positive integer');
            break;
        case 'queue-backlog':
            if (services.get(invariant.queue)?.kind !== 'queue') fail(`${invariant.queue} is not a queue`);
            if (!number(invariant.max, 1, 1e9)) fail('max must be positive');
            break;
        case 'failover-deadline':
            if (services.get(invariant.database)?.role !== 'primary') fail(`${invariant.database} is not a primary database`);
            if (!Number.isInteger(invariant.maxMs) || invariant.maxMs < 100) fail('maxMs must be an integer ≥ 100');
            break;
        default:
    }
    return true;
}

function validateInvariants(world, invariants) {
    if (!Array.isArray(invariants) || !invariants.length) throw new TypeError('at least one invariant is required');
    const ids = new Set();
    for (const invariant of invariants) {
        if (typeof invariant.id !== 'string' || !invariant.id) throw new TypeError('invariants need string ids');
        if (ids.has(invariant.id)) throw new TypeError(`duplicate invariant id ${invariant.id}`);
        ids.add(invariant.id);
        requireKnown(world, invariant);
    }
    return true;
}

function writeTarget(state, database) {
    const replica = replicaOf(state.world, database);
    return state.services[database].promoted && replica ? replica : database;
}

/**
 * One stateful monitor per invariant. `observe(state)` returns null or a
 * violation record; the failover monitor carries the time the write path
 * went down across observations, which is why monitors are objects.
 */
function createMonitor(invariant) {
    let downSinceMs = null;
    return {
        invariant,
        observe(state) {
            const derived = state.derived;
            switch (invariant.kind) {
                case 'route-available': {
                    if (!derived.routes[invariant.route].failing) return null;
                    const route = state.world.routes.find((item) => item.id === invariant.route);
                    return { expected: 'serving', observed: `failing (entry ${route.entry} down)`, subject: invariant.route };
                }
                case 'error-budget':
                    if (derived.errorSharePct <= invariant.maxPct) return null;
                    return { expected: `≤ ${invariant.maxPct}%`, observed: `${derived.errorSharePct}%`, subject: 'routes' };
                case 'min-healthy': {
                    const healthy = derived.health[invariant.service].healthy;
                    if (healthy >= invariant.min) return null;
                    return { expected: `≥ ${invariant.min}`, observed: String(healthy), subject: invariant.service };
                }
                case 'queue-backlog': {
                    const backlog = state.services[invariant.queue].backlog;
                    if (backlog <= invariant.max) return null;
                    return { expected: `≤ ${invariant.max}`, observed: String(Math.round(backlog)), subject: invariant.queue };
                }
                case 'failover-deadline': {
                    const target = writeTarget(state, invariant.database);
                    if (derived.health[target].up) { downSinceMs = null; return null; }
                    if (downSinceMs === null) downSinceMs = state.clockMs;
                    const down = state.clockMs - downSinceMs;
                    if (down <= invariant.maxMs) return null;
                    return { expected: `≤ ${invariant.maxMs} ms`, observed: `${down} ms without a writable ${invariant.database}`, subject: invariant.database };
                }
                default:
                    return null;
            }
        },
    };
}

/** Observe every monitor; returns the violations at this instant, in configured order. */
function observeAll(monitors, state) {
    const found = [];
    for (const monitor of monitors) {
        const violation = monitor.observe(state);
        if (violation) found.push({ invariant: monitor.invariant.id, kind: monitor.invariant.kind, atMs: state.clockMs, ...violation });
    }
    return found;
}

module.exports = {
    INVARIANT_KINDS,
    createMonitor,
    describeInvariant,
    observeAll,
    validateInvariants,
};
