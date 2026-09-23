'use strict';

// Heterogeneous graph export and the non-relational summaries that define
// pair identity (CLOUDPROOF-PHASE-III-MULTISERVICE.md, sections 3.5 and 4.2).
//
// The export carries no identifiers, no request load and no absolute clock:
// load is a function of the wiring and would hand relational information to a
// pooled model, and no feature counts elapsed simulation time.

const { NODE_TYPE, RELATION, RELATION_TYPES, SERVICE_KIND } = require('./constants');
const { podServing, volumeAvailable, nodeReady } = require('./engine');
const { stable } = require('./world');

const GRAPH_KIND = 'cloudproof.mesh-graph';

function round6(value) {
    return Math.round(value * 1e6) / 1e6;
}

function serviceGraph(state) {
    const world = state.world;
    const now = state.clockMs;
    const nodes = [];
    const edges = [];
    for (const zone of world.zones) {
        nodes.push({ id: zone.id, type: NODE_TYPE.ZONE, features: { degraded: state.zones[zone.id].degraded } });
    }
    for (const node of world.nodes) {
        nodes.push({ id: node.id, type: NODE_TYPE.NODE, features: {
            ready: nodeReady(state, node.id), cordoned: state.nodes[node.id].cordoned, slots: node.slots,
        } });
        edges.push({ type: RELATION.LOCATED_IN, from: node.id, to: node.zone });
    }
    for (const volume of world.volumes) {
        nodes.push({ id: volume.id, type: NODE_TYPE.VOLUME, features: { available: volumeAvailable(state, volume.id) } });
        edges.push({ type: RELATION.LOCATED_IN, from: volume.id, to: volume.zone });
    }
    const services = new Map(world.services.map((service) => [service.id, service]));
    for (const pod of state.pods) {
        nodes.push({ id: pod.id, type: NODE_TYPE.POD, features: { phase: pod.phase, serving: podServing(state, pod) } });
        edges.push({ type: RELATION.OWNS, from: pod.service, to: pod.id });
        if (pod.node) edges.push({ type: RELATION.RUNS_ON, from: pod.id, to: pod.node });
        const volume = services.get(pod.service).volume;
        if (volume) edges.push({ type: RELATION.MOUNTS, from: pod.id, to: volume });
    }
    for (const service of world.services) {
        const runtime = state.services[service.id];
        const health = state.derived.health[service.id];
        const isQueue = service.kind === SERVICE_KIND.QUEUE;
        nodes.push({ id: service.id, type: NODE_TYPE.SERVICE, features: {
            kind: service.kind,
            role: service.role || 'none',
            desiredReplicas: runtime.desiredReplicas,
            minHealthy: service.minHealthy,
            podCapacityRps: service.podCapacityRps,
            startupMs: service.startupMs,
            healthy: health.healthy,
            up: health.up,
            promoted: runtime.promoted,
            cacheCold: service.kind === SERVICE_KIND.CACHE && runtime.coldUntilMs > now,
            stalled: service.kind === SERVICE_KIND.WORKER && runtime.stalledUntilMs > now,
            queueCapacity: isQueue ? service.queueCapacity : 0,
            queueBacklogFraction: isQueue ? round6(Math.min(1, runtime.backlog / service.queueCapacity)) : 0,
            queueFull: isQueue ? state.derived.queueFull[service.id] : false,
        } });
    }
    for (const route of world.routes) {
        nodes.push({ id: route.id, type: NODE_TYPE.ROUTE, features: {
            sharePct: route.sharePct,
            rps: round6((route.sharePct / 100) * state.rps),
            failing: state.derived.routes[route.id].failing,
        } });
        edges.push({ type: RELATION.ENTERS, from: route.id, to: route.entry });
    }
    for (const edge of world.dependencies) edges.push({ type: edge.type, from: edge.from, to: edge.to });
    nodes.sort((left, right) => left.id.localeCompare(right.id));
    edges.sort((left, right) => (
        left.type.localeCompare(right.type) || left.from.localeCompare(right.from) || left.to.localeCompare(right.to)
    ));
    return stable({ schemaVersion: 1, kind: GRAPH_KIND, nodes: nodes.map((node) => ({ ...node, features: stable(node.features) })), edges });
}

function actionTarget(action) {
    return action?.nodeId || action?.zoneId || action?.serviceId || action?.podId || null;
}

function featureKey(node) {
    return JSON.stringify(stable(node.features));
}

function degreeVectors(graph) {
    const vectors = new Map(graph.nodes.map((node) => [node.id,
        Object.fromEntries(RELATION_TYPES.map((type) => [type, [0, 0]]))]));
    for (const edge of graph.edges) {
        vectors.get(edge.from)[edge.type][0] += 1;
        vectors.get(edge.to)[edge.type][1] += 1;
    }
    return new Map([...vectors].map(([id, vector]) => [id, JSON.stringify(vector)]));
}

function sortedBuckets(entries) {
    const buckets = {};
    for (const [type, value] of entries) (buckets[type] = buckets[type] || []).push(value);
    for (const list of Object.values(buckets)) list.sort();
    return stable(buckets);
}

// P1: per node type, the multiset of feature vectors with the action-target flag.
function pooledSummary(graph, action = null) {
    const target = actionTarget(action);
    return sortedBuckets(graph.nodes.map((node) => [node.type,
        JSON.stringify(stable({ ...node.features, isActionTarget: node.id === target }))]));
}

function coLocation(graph) {
    const owner = new Map();
    const podNode = new Map();
    const nodeZone = new Map();
    for (const edge of graph.edges) {
        if (edge.type === RELATION.OWNS) owner.set(edge.to, edge.from);
        if (edge.type === RELATION.RUNS_ON) podNode.set(edge.from, edge.to);
        if (edge.type === RELATION.LOCATED_IN) nodeZone.set(edge.from, edge.to);
    }
    const perNode = new Map();
    const perZone = new Map();
    const perService = new Map();
    for (const [pod, node] of podNode) {
        const service = owner.get(pod);
        const zone = nodeZone.get(node);
        for (const [map, key, value] of [[perNode, node, service], [perZone, zone, service]]) {
            if (!map.has(key)) map.set(key, { pods: 0, services: new Set() });
            map.get(key).pods += 1;
            map.get(key).services.add(value);
        }
        if (!perService.has(service)) perService.set(service, { nodes: new Set(), zones: new Set() });
        perService.get(service).nodes.add(node);
        perService.get(service).zones.add(zone);
    }
    return (node) => {
        if (node.type === NODE_TYPE.NODE || node.type === NODE_TYPE.ZONE) {
            const item = (node.type === NODE_TYPE.NODE ? perNode : perZone).get(node.id);
            return item ? [item.pods, item.services.size] : [0, 0];
        }
        if (node.type === NODE_TYPE.SERVICE) {
            const item = perService.get(node.id);
            return item ? [item.nodes.size, item.zones.size] : [0, 0];
        }
        return null;
    };
}

// P2: everything a degree-aware flat baseline may see.
function degreeAwareSummary(graph, action = null) {
    const target = actionTarget(action);
    const degrees = degreeVectors(graph);
    const location = coLocation(graph);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const key = (node) => `${featureKey(node)}|${degrees.get(node.id)}`;
    const joint = sortedBuckets(graph.nodes.map((node) => [node.type, key(node)]));
    const colocated = sortedBuckets(graph.nodes
        .filter((node) => location(node) !== null)
        .map((node) => [node.type, `${featureKey(node)}|${JSON.stringify(location(node))}`]));
    let targetSummary = null;
    if (target && byId.has(target)) {
        const node = byId.get(target);
        const neighbours = graph.edges.flatMap((edge) => {
            if (edge.from === target) return [`${edge.type}|out|${byId.get(edge.to).type}|${key(byId.get(edge.to))}`];
            if (edge.to === target) return [`${edge.type}|in|${byId.get(edge.from).type}|${key(byId.get(edge.from))}`];
            return [];
        }).sort();
        targetSummary = { type: node.type, key: key(node), location: location(node), neighbours };
    }
    return stable({ pooled: pooledSummary(graph, action), joint, colocated, target: targetSummary });
}

function relationDifferences(left, right) {
    return RELATION_TYPES.filter((type) => (
        JSON.stringify(left.edges.filter((edge) => edge.type === type))
        !== JSON.stringify(right.edges.filter((edge) => edge.type === type))
    ));
}

/** P1, P2, P4 and the node half of P5 for two members at the same row. */
function comparePairGraphs(left, right, action) {
    const nodeFeatures = (graph) => JSON.stringify(graph.nodes.map((node) => [node.id, node.type, featureKey(node)]));
    return stable({
        pooledIdentical: JSON.stringify(pooledSummary(left, action)) === JSON.stringify(pooledSummary(right, action)),
        degreeAwareIdentical: JSON.stringify(degreeAwareSummary(left, action))
            === JSON.stringify(degreeAwareSummary(right, action)),
        nodesIdenticalById: nodeFeatures(left) === nodeFeatures(right),
        differingRelations: relationDifferences(left, right),
    });
}

// Shortest undirected path length between two graph nodes (report only).
function hopDistance(graph, from, to) {
    const adjacent = new Map(graph.nodes.map((node) => [node.id, []]));
    for (const edge of graph.edges) {
        adjacent.get(edge.from).push(edge.to);
        adjacent.get(edge.to).push(edge.from);
    }
    const distance = new Map([[from, 0]]);
    const queue = [from];
    while (queue.length) {
        const current = queue.shift();
        if (current === to) return distance.get(current);
        for (const next of adjacent.get(current) || []) {
            if (!distance.has(next)) { distance.set(next, distance.get(current) + 1); queue.push(next); }
        }
    }
    return null;
}

module.exports = {
    GRAPH_KIND,
    actionTarget,
    comparePairGraphs,
    degreeAwareSummary,
    hopDistance,
    pooledSummary,
    serviceGraph,
};
