'use strict';

// Canonical graph data for the Operations Console renderer.
//
// The renderer draws exactly this object; it never reads simulator state. The
// layout is a pure function of the world's structure (not of its runtime
// state), so nodes stay where they are while a replay moves through time.

const { POD_PHASE, RELATION, SERVICE_KIND } = require('../cloudproof-mesh/constants');
const { nodeReady, podServing, volumeAvailable } = require('../cloudproof-mesh/engine');
const { replicaOf } = require('../cloudproof-mesh/world');

const GRAPH_KIND = 'cloudproof.ops-graph';
const NODE_W = 176;
const NODE_H = 90;
const GAP_X = 30;
const GAP_Y = 58;
const ROUTE_H = 30;
const PAD = 24;

const EDGE_SEMANTICS = Object.freeze({
    CALLS: { hard: true, verb: 'calls' },
    CALLS_OPTIONAL: { hard: false, verb: 'optionally calls' },
    READS_THROUGH: { hard: true, verb: 'reads through' },
    BACKED_BY: { hard: false, verb: 'misses fall through to' },
    WRITES: { hard: true, verb: 'writes' },
    READS: { hard: true, verb: 'reads' },
    REPLICATES: { hard: false, verb: 'replicates to' },
    PUBLISHES: { hard: true, verb: 'publishes to' },
    CONSUMES: { hard: false, verb: 'consumes from' },
});

function edgeId(edge) {
    return `${edge.type}:${edge.from}->${edge.to}`;
}

// Direction requests travel: CONSUMES is written worker -> queue but work
// flows queue -> worker.
function flowOf(edge) {
    return edge.type === RELATION.CONSUMES ? [edge.to, edge.from] : [edge.from, edge.to];
}

/** Layered layout: routes on top, stateless tiers by longest path, storage at the bottom. */
function layoutWorld(world) {
    const services = world.services.map((item) => item.id).sort();
    const kinds = new Map(world.services.map((item) => [item.id, item.kind]));
    const next = new Map(services.map((id) => [id, []]));
    const parents = new Map(services.map((id) => [id, []]));
    for (const edge of world.dependencies) {
        const [from, to] = flowOf(edge);
        next.get(from).push(to);
        parents.get(to).push(from);
    }
    const entries = new Set(world.routes.map((route) => route.entry));
    const depth = new Map();
    const visit = (id, seen = new Set()) => {
        if (depth.has(id)) return depth.get(id);
        if (seen.has(id)) return 1;
        seen.add(id);
        const incoming = parents.get(id).filter((parent) => kinds.get(parent) !== SERVICE_KIND.DATABASE);
        const value = incoming.length ? 1 + Math.max(...incoming.map((parent) => visit(parent, seen))) : 1;
        depth.set(id, value);
        return value;
    };
    services.forEach((id) => visit(id));
    for (const id of entries) depth.set(id, 1);
    const storage = services.filter((id) => kinds.get(id) === SERVICE_KIND.DATABASE);
    const compute = services.filter((id) => kinds.get(id) !== SERVICE_KIND.DATABASE);
    const bottom = Math.max(1, ...compute.map((id) => depth.get(id))) + 1;
    for (const id of storage) depth.set(id, bottom);
    const layers = [];
    for (const id of services) {
        const layer = depth.get(id);
        (layers[layer] = layers[layer] || []).push(id);
    }
    const order = new Map();
    world.routes.forEach((route, index) => order.set(`route:${route.id}`, index));
    // Entries follow route order; each later layer sorts by the mean position
    // of its parents, ties broken by id. Two sweeps are plenty at this size.
    const routeIndex = new Map();
    world.routes.forEach((route, index) => { if (!routeIndex.has(route.entry)) routeIndex.set(route.entry, index); });
    // Ties go to request-path tiers first (an API before the queue it feeds).
    const rank = { api: 0, cache: 1, queue: 2, worker: 3, database: 4 };
    const placeLayer = (ids, key) => ids.slice().sort((left, right) => key(left) - key(right)
        || rank[kinds.get(left)] - rank[kinds.get(right)] || left.localeCompare(right));
    for (let sweep = 0; sweep < 2; sweep += 1) {
        for (let layer = 1; layer < layers.length; layer += 1) {
            if (!layers[layer]) continue;
            const key = (id) => {
                if (layer === 1 && routeIndex.has(id)) return routeIndex.get(id);
                const known = parents.get(id).filter((parent) => order.has(parent));
                if (!known.length) return layer === 1 ? 1000 : (order.get(id) ?? 1000);
                return known.reduce((sum, parent) => sum + order.get(parent), 0) / known.length;
            };
            layers[layer] = placeLayer(layers[layer], key);
            layers[layer].forEach((id, index) => order.set(id, index + (layer === 1 ? 0 : 0)));
        }
    }
    const widest = Math.max(world.routes.length, ...layers.filter(Boolean).map((ids) => ids.length));
    const width = PAD * 2 + widest * NODE_W + (widest - 1) * GAP_X;
    const positions = {};
    const rowY = (layer) => PAD + ROUTE_H + GAP_Y * 0.6 + (layer - 1) * (NODE_H + GAP_Y);
    const centre = (count, index, itemWidth) => {
        const span = count * itemWidth + (count - 1) * GAP_X;
        return (width - span) / 2 + index * (itemWidth + GAP_X);
    };
    for (let layer = 1; layer < layers.length; layer += 1) {
        const ids = layers[layer] || [];
        ids.forEach((id, index) => { positions[id] = { x: centre(ids.length, index, NODE_W), y: rowY(layer), layer }; });
    }
    const routes = {};
    world.routes.forEach((route) => {
        const target = positions[route.entry];
        routes[route.id] = { x: target.x + NODE_W / 2, y: PAD };
    });
    // Two routes entering one service would overlap; fan them out.
    const byEntry = new Map();
    for (const route of world.routes) (byEntry.get(route.entry) || byEntry.set(route.entry, []).get(route.entry)).push(route.id);
    for (const ids of byEntry.values()) {
        ids.forEach((id, index) => { routes[id].x += (index - (ids.length - 1) / 2) * 44; });
    }
    const height = rowY(layers.length - 1) + NODE_H + PAD;
    return { width, height, node: { width: NODE_W, height: NODE_H }, positions, routes };
}

function podFacts(state, pod) {
    return { id: pod.id, service: pod.service, node: pod.node, phase: pod.phase, serving: podServing(state, pod) };
}

/**
 * Canonical graph data for one simulator state. `meta` carries labels and
 * versions for display only.
 */
function graphModel(state, meta = {}) {
    const world = state.world;
    const labels = meta.labels || {};
    const versions = meta.versions || {};
    const layout = meta.layout || layoutWorld(world);
    const derived = state.derived;
    const zoneOfNode = new Map(world.nodes.map((node) => [node.id, node.zone]));
    const services = world.services.map((item) => {
        const health = derived.health[item.id];
        const runtime = state.services[item.id];
        const pods = state.pods.filter((pod) => pod.service === item.id).map((pod) => podFacts(state, pod));
        const zones = {};
        for (const zone of world.zones) zones[zone.id] = { total: 0, serving: 0 };
        for (const pod of pods) {
            if (!pod.node) continue;
            const zone = zoneOfNode.get(pod.node);
            zones[zone].total += 1;
            if (pod.serving) zones[zone].serving += 1;
        }
        const replica = item.role === 'primary' ? replicaOf(world, item.id) : null;
        return {
            id: item.id,
            label: labels[item.id] || item.id,
            version: versions[item.id] || null,
            kind: item.kind,
            role: item.role,
            desired: runtime.desiredReplicas,
            minHealthy: item.minHealthy,
            healthy: health.healthy,
            podCapacityRps: item.podCapacityRps,
            capacityRps: health.capacityRps,
            loadRps: Math.round(health.load * 10) / 10,
            utilization: health.capacityRps ? Math.round((health.load / health.capacityRps) * 1000) / 1000 : null,
            up: health.up,
            intrinsicUp: health.intrinsicUp,
            overloaded: Boolean(health.overloaded),
            cause: health.cause,
            promoted: runtime.promoted,
            replica,
            cacheCold: item.kind === SERVICE_KIND.CACHE && runtime.coldUntilMs > state.clockMs,
            stalled: item.kind === SERVICE_KIND.WORKER && runtime.stalledUntilMs > state.clockMs,
            backlog: item.kind === SERVICE_KIND.QUEUE ? Math.round(runtime.backlog) : null,
            queueCapacity: item.queueCapacity,
            queueFull: item.kind === SERVICE_KIND.QUEUE ? Boolean(derived.queueFull[item.id]) : false,
            volume: item.volume ? { id: item.volume, available: volumeAvailable(state, item.volume) } : null,
            zones,
            pods,
            position: layout.positions[item.id],
        };
    });
    const edges = world.dependencies.map((edge) => {
        const [flowFrom, flowTo] = flowOf(edge);
        return {
            id: edgeId(edge),
            type: edge.type,
            from: edge.from,
            to: edge.to,
            flowFrom,
            flowTo,
            hard: EDGE_SEMANTICS[edge.type].hard,
            verb: EDGE_SEMANTICS[edge.type].verb,
        };
    });
    const routes = world.routes.map((route) => ({
        id: route.id,
        entry: route.entry,
        sharePct: route.sharePct,
        rps: Math.round((route.sharePct / 100) * state.rps),
        failing: derived.routes[route.id].failing,
        position: layout.routes[route.id],
    }));
    const zones = world.zones.map((zone) => ({
        id: zone.id,
        degraded: state.zones[zone.id].degraded,
        nodes: world.nodes.filter((node) => node.zone === zone.id).map((node) => ({
            id: node.id,
            slots: node.slots,
            ready: nodeReady(state, node.id),
            crashed: state.nodes[node.id].crashed,
            cordoned: state.nodes[node.id].cordoned,
            pods: state.pods.filter((pod) => pod.node === node.id).map((pod) => podFacts(state, pod)),
        })),
    }));
    const unplaced = state.pods.filter((pod) => !pod.node || pod.phase === POD_PHASE.PENDING)
        .filter((pod) => !pod.node).map((pod) => podFacts(state, pod));
    return {
        schemaVersion: 1,
        kind: GRAPH_KIND,
        clockMs: state.clockMs,
        rps: state.rps,
        baseRps: world.traffic.rps,
        services,
        edges,
        routes,
        zones,
        unplaced,
        derived: { violating: derived.violating, errorSharePct: derived.errorSharePct, incident: derived.incident },
        layout: { width: layout.width, height: layout.height, node: layout.node },
    };
}

module.exports = {
    EDGE_SEMANTICS,
    GRAPH_KIND,
    edgeId,
    flowOf,
    graphModel,
    layoutWorld,
};
