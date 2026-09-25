'use strict';

// Root causes, read from the causes the CloudProof Mesh engine records on
// every service during propagation (`state.derived.health[id].cause`).

const { INCIDENT_CLASS } = require('../cloudproof-mesh/constants');

/** Walk the engine's recorded causes from `serviceId` to an intrinsic root. */
function causalChain(state, serviceId) {
    const chain = [serviceId];
    let current = serviceId;
    const seen = new Set([serviceId]);
    for (;;) {
        const cause = state.derived.health[current]?.cause;
        if (!cause) return { chain, root: current, incidentClass: null };
        if (cause.kind === 'intrinsic') return { chain, root: current, incidentClass: cause.class };
        if (cause.kind === 'backpressure') {
            chain.push(cause.via);
            return { chain, root: cause.via, incidentClass: INCIDENT_CLASS.QUEUE_BACKPRESSURE };
        }
        if (seen.has(cause.via)) return { chain, root: current, incidentClass: INCIDENT_CLASS.INSTANCE_LOSS };
        seen.add(cause.via);
        chain.push(cause.via);
        current = cause.via;
    }
}

function worstFailingRoute(state) {
    return state.world.routes
        .filter((route) => state.derived.routes[route.id].failing)
        .sort((left, right) => right.sharePct - left.sharePct || left.id.localeCompare(right.id))[0] || null;
}

/** Root cause of one violation, computed for that invariant's own subject. */
function rootCauseOf(state, violation, invariant) {
    const world = state.world;
    switch (invariant.kind) {
        case 'route-available': {
            const route = world.routes.find((item) => item.id === invariant.route);
            return { route: route.id, ...causalChain(state, route.entry) };
        }
        case 'error-budget': {
            const route = worstFailingRoute(state);
            return route ? { route: route.id, ...causalChain(state, route.entry) } : { route: null, chain: [], root: null, incidentClass: null };
        }
        case 'min-healthy':
            return { route: null, chain: [invariant.service], root: invariant.service, incidentClass: INCIDENT_CLASS.INSTANCE_LOSS };
        case 'queue-backlog':
            return { route: null, chain: [invariant.queue], root: invariant.queue, incidentClass: 'QUEUE_BACKLOG' };
        case 'failover-deadline': {
            const cause = state.derived.health[invariant.database].cause;
            return {
                route: null,
                chain: [invariant.database],
                root: invariant.database,
                incidentClass: cause?.kind === 'intrinsic' ? cause.class : INCIDENT_CLASS.INSTANCE_LOSS,
            };
        }
        default:
            return { route: null, chain: [], root: null, incidentClass: null };
    }
}

module.exports = { causalChain, rootCauseOf, worstFailingRoute };
