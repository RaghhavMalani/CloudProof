'use strict';

// Counterfactual pairs for Phase III (CLOUDPROOF-PHASE-III-MULTISERVICE.md,
// section 4). Each family embeds a motif in a world sampled from a template.
// The two wirings W and W' differ by one degree-preserving double-edge swap
// inside a single relation type; the fault is drawn 50/50 between two motif
// targets, where under the first W exposes the high-share route and under
// the second W' does; which wiring is called "A" is a seeded coin. Truth is
// whatever the simulator executes to.

const { digest } = require('../agent-runtime');
const { Rng } = require('../../sim/simulator');
const { MESH_ACTION, MESH_FAULT, RELATION, SERVICE_KIND } = require('./constants');
const { createMeshState, step } = require('./engine');
const {
    assignBaseRoutes,
    placePods,
    sampleSkeleton,
    sizeCapacities,
    template,
    variantWorld,
} = require('./generator');
const { actionTarget, comparePairGraphs, hopDistance, serviceGraph } = require('./graph');
const { meshSchedule, runMeshSchedule } = require('./runner');
const { stable, validateWorld } = require('./world');

const PAIR_FAMILIES = Object.freeze(['route-entry', 'call-dependency', 'cache-backing', 'storage-zone', 'queue-consumer']);

const SWAPPED_RELATION = Object.freeze({
    'route-entry': RELATION.ENTERS,
    'call-dependency': RELATION.CALLS,
    'cache-backing': RELATION.BACKED_BY,
    'storage-zone': RELATION.WRITES,
    'queue-consumer': RELATION.CONSUMES,
});

const RPS = 1000;
const WARMUP_MS = 500;
const CONTINUATION = Object.freeze({ steps: 25, ms: 200 });

// Motif parameter ranges, frozen after the III-A.2 simulator-only pilot (section 12).
const MOTIF = Object.freeze({
    highSharePct: [25, 40],
    lowSharePct: [5, 15],
    readerSharePct: [20, 30],
    storeUtilization: [60, 90],
    queueSeconds: [5, 30],
});

const between = (rng, [low, high]) => rng.range(low, high);

// Two services with identical static parameters (the swapped twins).
function twins(rng, skeleton, kind, overrides = {}) {
    const replicas = overrides.replicas ?? (kind === SERVICE_KIND.DATABASE ? rng.range(1, 2) : between(rng, skeleton.template.replicas));
    const shared = {
        replicas,
        minHealthy: overrides.minHealthy ?? (kind === SERVICE_KIND.DATABASE ? 1 : Math.ceil(replicas / 2)),
        startupMs: overrides.startupMs ?? 100 * rng.range(skeleton.template.startupMs[0] / 100, skeleton.template.startupMs[1] / 100),
        utilization: overrides.utilization ?? between(rng, [25, 55]) / 100,
        role: overrides.role,
    };
    return [skeleton.addService(kind, rng, shared), skeleton.addService(kind, rng, shared)];
}

function reserveRoutes(rng, skeleton, extraShares = []) {
    const high = between(rng, MOTIF.highSharePct);
    const low = between(rng, MOTIF.lowSharePct);
    assignBaseRoutes(rng, skeleton, high + low + extraShares.reduce((sum, share) => sum + share, 0));
    return { high, low };
}

function sharedCallee(rng, skeleton) {
    return rng.chance(0.5) ? rng.pick(skeleton.layers[0]) : null;
}

function withEdges(skeleton, edges) {
    return skeleton.dependencies.concat(edges.map(([type, from, to]) => ({ type, from, to })));
}

function swapEntries(routes, first, second) {
    const entries = new Map(routes.map((route) => [route.id, route.entry]));
    return routes.map((route) => {
        if (route.id === first) return { ...route, entry: entries.get(second) };
        if (route.id === second) return { ...route, entry: entries.get(first) };
        return route;
    });
}

function dedicatedNodes(rng, skeleton, count) {
    return Array.from({ length: count }, () => skeleton.addNode(rng.pick(skeleton.zones).id, skeleton.template.slots));
}

function podsOnNode(node, count) {
    return Array.from({ length: count }, () => node);
}

const EMBED = {
    // F1: which of two identical entries the high-share route enters.
    'route-entry'(rng, skeleton) {
        const [p, q] = twins(rng, skeleton, SERVICE_KIND.API);
        const callee = sharedCallee(rng, skeleton);
        if (callee) { skeleton.connect(RELATION.CALLS, p, callee); skeleton.connect(RELATION.CALLS, q, callee); }
        const k = rng.range(1, skeleton.service(p).replicas);
        const [nodeP, nodeQ] = dedicatedNodes(rng, skeleton, 2);
        const shares = reserveRoutes(rng, skeleton);
        const high = skeleton.addRoute(shares.high, p);
        const low = skeleton.addRoute(shares.low, q);
        return {
            variants: { W: { routes: skeleton.routes, dependencies: skeleton.dependencies },
                Wp: { routes: swapEntries(skeleton.routes, high, low), dependencies: skeleton.dependencies } },
            faults: [{ type: MESH_FAULT.NODE_CRASH, nodeId: nodeP }, { type: MESH_FAULT.NODE_CRASH, nodeId: nodeQ }],
            criticalRoute: high,
            pinned: { [p]: podsOnNode(nodeP, k), [q]: podsOnNode(nodeQ, k) },
            groups: [[p, q]],
            motif: { twins: [p, q], dedicatedNodes: [nodeP, nodeQ], podsOnDedicatedNode: k, shares },
        };
    },

    // F2: which of two identical callees the high-share entry calls.
    'call-dependency'(rng, skeleton) {
        const [c1, c2] = twins(rng, skeleton, SERVICE_KIND.API);
        const [x, y] = twins(rng, skeleton, SERVICE_KIND.API);
        const callee = sharedCallee(rng, skeleton);
        if (callee) { skeleton.connect(RELATION.CALLS, c1, callee); skeleton.connect(RELATION.CALLS, c2, callee); }
        if (rng.chance(0.5)) {
            const database = rng.pick(skeleton.databases);
            skeleton.connect(RELATION.WRITES, x, database);
            skeleton.connect(RELATION.WRITES, y, database);
        }
        const k = rng.range(1, skeleton.service(x).replicas);
        const [nodeX, nodeY] = dedicatedNodes(rng, skeleton, 2);
        const shares = reserveRoutes(rng, skeleton);
        const high = skeleton.addRoute(shares.high, c1);
        skeleton.addRoute(shares.low, c2);
        return {
            variants: {
                W: { routes: skeleton.routes, dependencies: withEdges(skeleton, [[RELATION.CALLS, c1, x], [RELATION.CALLS, c2, y]]) },
                Wp: { routes: skeleton.routes, dependencies: withEdges(skeleton, [[RELATION.CALLS, c1, y], [RELATION.CALLS, c2, x]]) },
            },
            faults: [{ type: MESH_FAULT.NODE_CRASH, nodeId: nodeX }, { type: MESH_FAULT.NODE_CRASH, nodeId: nodeY }],
            criticalRoute: high,
            pinned: { [x]: podsOnNode(nodeX, k), [y]: podsOnNode(nodeY, k) },
            groups: [[c1, c2], [x, y]],
            motif: { twins: [x, y], dedicatedNodes: [nodeX, nodeY], podsOnDedicatedNode: k, shares },
        };
    },

    // F3: which of two identical stores a flushed cache falls through to.
    'cache-backing'(rng, skeleton) {
        const [e1, e2] = twins(rng, skeleton, SERVICE_KIND.API);
        const zones = skeleton.zones.map((zone) => zone.id);
        const storeUtilization = between(rng, MOTIF.storeUtilization) / 100;
        const [s1, s2] = twins(rng, skeleton, SERVICE_KIND.DATABASE, { role: 'primary', utilization: storeUtilization });
        skeleton.attachVolume(s1, rng.pick(zones));
        skeleton.attachVolume(s2, rng.pick(zones));
        const [k1, k2] = twins(rng, skeleton, SERVICE_KIND.CACHE);
        const reader = skeleton.addService(SERVICE_KIND.API, rng);
        skeleton.connect(RELATION.WRITES, e1, s1);
        skeleton.connect(RELATION.WRITES, e2, s2);
        skeleton.connect(RELATION.READS_THROUGH, reader, k1);
        skeleton.connect(RELATION.READS_THROUGH, reader, k2);
        const readerShare = between(rng, MOTIF.readerSharePct);
        const shares = reserveRoutes(rng, skeleton, [readerShare]);
        const high = skeleton.addRoute(shares.high, e1);
        skeleton.addRoute(shares.low, e2);
        skeleton.addRoute(readerShare, reader);
        return {
            variants: {
                W: { routes: skeleton.routes, dependencies: withEdges(skeleton, [[RELATION.BACKED_BY, k1, s1], [RELATION.BACKED_BY, k2, s2]]) },
                Wp: { routes: skeleton.routes, dependencies: withEdges(skeleton, [[RELATION.BACKED_BY, k1, s2], [RELATION.BACKED_BY, k2, s1]]) },
            },
            faults: [{ type: MESH_FAULT.CACHE_FLUSH, serviceId: k1 }, { type: MESH_FAULT.CACHE_FLUSH, serviceId: k2 }],
            criticalRoute: high,
            pinned: {},
            groups: [[e1, e2], [s1, s2], [k1, k2]],
            motif: { twins: [k1, k2], stores: [s1, s2], storeUtilization, shares: { ...shares, reader: readerShare } },
        };
    },

    // F4: which of two identical databases, each in its own storage zone,
    // the high-share writer depends on when one of those zones degrades.
    // Dedicated storage zones keep the zone fault from also removing a share
    // of every compute service, which would make both members fail.
    'storage-zone'(rng, skeleton) {
        const [e1, e2] = twins(rng, skeleton, SERVICE_KIND.API);
        const [d1, d2] = twins(rng, skeleton, SERVICE_KIND.DATABASE, { role: 'primary' });
        const zoneA = skeleton.addZone();
        const zoneB = skeleton.addZone();
        const nodeA = skeleton.addNode(zoneA, skeleton.template.slots);
        const nodeB = skeleton.addNode(zoneB, skeleton.template.slots);
        skeleton.attachVolume(d1, zoneA);
        skeleton.attachVolume(d2, zoneB);
        const replicas = skeleton.service(d1).replicas;
        const shares = reserveRoutes(rng, skeleton);
        const high = skeleton.addRoute(shares.high, e1);
        skeleton.addRoute(shares.low, e2);
        return {
            variants: {
                W: { routes: skeleton.routes, dependencies: withEdges(skeleton, [[RELATION.WRITES, e1, d1], [RELATION.WRITES, e2, d2]]) },
                Wp: { routes: skeleton.routes, dependencies: withEdges(skeleton, [[RELATION.WRITES, e1, d2], [RELATION.WRITES, e2, d1]]) },
            },
            faults: [{ type: MESH_FAULT.ZONE_DEGRADED, zoneId: zoneA }, { type: MESH_FAULT.ZONE_DEGRADED, zoneId: zoneB }],
            criticalRoute: high,
            pinned: { [d1]: podsOnNode(nodeA, replicas), [d2]: podsOnNode(nodeB, replicas) },
            groups: [[e1, e2], [d1, d2]],
            motif: { twins: [d1, d2], zones: [zoneA, zoneB], shares },
        };
    },

    // F5: which of two identical workers drains the high-rate queue.
    'queue-consumer'(rng, skeleton) {
        const [p1, p2] = twins(rng, skeleton, SERVICE_KIND.API);
        const [q1, q2] = twins(rng, skeleton, SERVICE_KIND.QUEUE);
        const [w1, w2] = twins(rng, skeleton, SERVICE_KIND.WORKER);
        skeleton.connect(RELATION.PUBLISHES, p1, q1);
        skeleton.connect(RELATION.PUBLISHES, p2, q2);
        const [node1, node2] = dedicatedNodes(rng, skeleton, 2);
        const replicas = skeleton.service(w1).replicas;
        const queueSeconds = between(rng, MOTIF.queueSeconds) / 10;
        const shares = reserveRoutes(rng, skeleton);
        const high = skeleton.addRoute(shares.high, p1);
        skeleton.addRoute(shares.low, p2);
        return {
            variants: {
                W: { routes: skeleton.routes, dependencies: withEdges(skeleton, [[RELATION.CONSUMES, w1, q1], [RELATION.CONSUMES, w2, q2]]) },
                Wp: { routes: skeleton.routes, dependencies: withEdges(skeleton, [[RELATION.CONSUMES, w1, q2], [RELATION.CONSUMES, w2, q1]]) },
            },
            faults: [{ type: MESH_FAULT.NODE_CRASH, nodeId: node1 }, { type: MESH_FAULT.NODE_CRASH, nodeId: node2 }],
            criticalRoute: high,
            pinned: { [w1]: podsOnNode(node1, replicas), [w2]: podsOnNode(node2, replicas) },
            groups: [[p1, p2], [q1, q2], [w1, w2]],
            queueSeconds: { [q1]: queueSeconds, [q2]: queueSeconds },
            motif: { twins: [w1, w2], queues: [q1, q2], dedicatedNodes: [node1, node2], queueSeconds, shares },
        };
    },
};

function familySalt(family) {
    return PAIR_FAMILIES.indexOf(family) + 1;
}

/** Build both members of one pair; nothing here runs the simulator. */
function buildPair({ seed, family, templateId }) {
    if (!EMBED[family]) throw new TypeError(`unknown pair family: ${family}`);
    const entry = template(templateId);
    const rng = new Rng(((seed * 2654435761) ^ (familySalt(family) * 0x9e3779b9)) >>> 0);
    const skeleton = sampleSkeleton(rng, entry);
    const motif = EMBED[family](rng, skeleton);
    sizeCapacities(rng, skeleton, [motif.variants.W, motif.variants.Wp], RPS,
        { groups: motif.groups, queueSeconds: motif.queueSeconds });
    const { placement, policy } = placePods(rng, skeleton, motif.pinned);
    const worlds = {
        W: variantWorld(skeleton, motif.variants.W, placement, RPS),
        Wp: variantWorld(skeleton, motif.variants.Wp, placement, RPS),
    };
    validateWorld(worlds.W);
    validateWorld(worlds.Wp);
    const faultIndex = rng.int(2);
    const fault = motif.faults[faultIndex];
    const order = rng.chance(0.5) ? { A: 'W', B: 'Wp' } : { A: 'Wp', B: 'W' };
    const actions = [
        { type: MESH_ACTION.ADVANCE_TIME, ms: WARMUP_MS },
        fault,
        ...Array.from({ length: CONTINUATION.steps }, () => ({ type: MESH_ACTION.ADVANCE_TIME, ms: CONTINUATION.ms })),
    ];
    const pairId = `mesh-pair-${family}-${templateId}-${seed}`;
    const schedules = Object.fromEntries(['A', 'B'].map((member) => [member, meshSchedule({
        seed, world: worlds[order[member]], actions,
        metadata: { pairId, variant: member, family },
    })]));
    return stable({
        pairId,
        family,
        template: templateId,
        split: entry.split,
        seed,
        swappedRelation: SWAPPED_RELATION[family],
        fault,
        faultIndex,
        exposedWiring: faultIndex === 0 ? 'W' : 'Wp',
        order,
        criticalRoute: motif.criticalRoute,
        placementPolicy: policy,
        motif: motif.motif,
        wiringDigests: { W: digest(worlds.W.dependencies.concat(worlds.W.routes)), Wp: digest(worlds.Wp.dependencies.concat(worlds.Wp.routes)) },
        schedules,
    });
}

/** Run both members, check P1-P5 at the intervention row, and label the pair. */
function evaluatePair(pair) {
    const members = ['A', 'B'];
    const fault = pair.fault;
    const intervention = {};
    for (const member of members) {
        const schedule = pair.schedules[member];
        const warm = step(createMeshState(schedule.world), schedule.actions[0]);
        intervention[member] = { state: warm.state, violated: Boolean(warm.violation) };
    }
    const graphs = Object.fromEntries(members.map((member) => [member, serviceGraph(intervention[member].state)]));
    const comparison = comparePairGraphs(graphs.A, graphs.B, fault);
    const runs = Object.fromEntries(members.map((member) => [member, runMeshSchedule(pair.schedules[member])]));
    const preFault = members.some((member) => intervention[member].violated || !runs[member].valid);
    const assertions = {
        P1_pooledIdentical: comparison.pooledIdentical,
        P2_degreeAwareIdentical: comparison.degreeAwareIdentical,
        P3_sameActions: JSON.stringify(pair.schedules.A.actions) === JSON.stringify(pair.schedules.B.actions),
        P4_onlySwappedRelationDiffers: JSON.stringify(comparison.differingRelations) === JSON.stringify([pair.swappedRelation]),
        P5_sameNodesNoPreFaultViolation: comparison.nodesIdenticalById && !preFault,
    };
    const valid = Object.values(assertions).every(Boolean);
    const unsafe = Object.fromEntries(members.map((member) => [member, Boolean(runs[member].outcome?.unsafe)]));
    const decisive = valid && unsafe.A !== unsafe.B;
    const riskier = decisive ? (unsafe.A ? 'A' : 'B') : null;
    const exposedMember = pair.order.A === pair.exposedWiring ? 'A' : 'B';
    const target = actionTarget(fault);
    return stable({
        pairId: pair.pairId,
        family: pair.family,
        template: pair.template,
        split: pair.split,
        seed: pair.seed,
        valid,
        assertions,
        truth: Object.fromEntries(members.map((member) => [member, {
            unsafe: unsafe[member],
            failure: runs[member].outcome?.failure || null,
            fingerprint: runs[member].fingerprint || null,
        }])),
        decisive,
        riskier,
        exposedMember,
        riskierIsExposed: decisive ? riskier === exposedMember : null,
        canonicalRiskier: decisive ? pair.order[riskier] === 'W' : null,
        hopsFromFaultToCriticalRoute: hopDistance(graphs[exposedMember], target, pair.criticalRoute),
    });
}

module.exports = {
    CONTINUATION,
    MOTIF,
    PAIR_FAMILIES,
    SWAPPED_RELATION,
    WARMUP_MS,
    buildPair,
    evaluatePair,
};
