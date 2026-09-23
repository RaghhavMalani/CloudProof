'use strict';

// Counterfactual topology pairs for Phase II-A.2.
//
// Two worlds share one seed, one traffic level, one runtime, one quiet
// reconciliation prefix, one intervention, and one sampled continuation. They
// differ in exactly one topology intervention expressed through the ordinary
// schedule contract (`scenarioParameters.placement`), so every pair member is a
// replayable schedule and the pair truth is whatever the simulator executes.

const { Rng } = require('../../sim/simulator');
const { CLOUD_ACTION, CLOUD_FAULT } = require('./faults');
const {
    balancedPodsPerZone,
    concentratedPodsPerZone,
    defaultNodesPerZone,
    nodeNameList,
    nodeZoneIndexes,
    normalizePlacement,
    placementConcentration,
    slotsPerNode,
    zoneName,
} = require('./placement');
const { stable } = require('./state');
const { areaUnderRoc } = require('./transition-dataset');

const PAIR_FAMILIES = Object.freeze([
    'zone-placement',
    'node-placement',
    'pdb-placement',
    'capacity-distribution',
    'node-concentration',
    'readiness-wiring',
    'readiness-drain',
]);

// Relational-only families keep every per-type node-feature multiset, every
// per-zone pod count, the endpoint count, the zone-concentration statistic and
// the intervention identical between members; only which resource is related
// to which differs. A permutation-invariant pooled model receives identical
// inputs for both members by construction.
const RELATIONAL_ONLY_FAMILIES = Object.freeze([
    'capacity-distribution',
    'node-concentration',
    'readiness-wiring',
    'readiness-drain',
]);

const FAMILY_DESCRIPTIONS = Object.freeze({
    'zone-placement': 'balanced pods per zone versus pods concentrated in the zone that then degrades',
    'node-placement': 'balanced pods per zone versus pods concentrated in the zone whose first node then crashes',
    'pdb-placement': 'balanced pods per zone versus pods concentrated in the zone whose first node is then drained under the PDB',
    'capacity-distribution': 'identical pods; the one spare node sits outside versus inside the zone that then degrades',
    'node-concentration': 'identical per-zone pod counts; the target zone has two nodes and its pods are spread over both versus stacked on the node that then crashes',
    'readiness-wiring': 'identical pod multiset with k not-yet-ready pods; they sit inside the zone that then degrades versus in the other zones',
    'readiness-drain': 'identical pod multiset with k not-yet-ready pods; they sit on the node that is then drained versus elsewhere',
});

function spreadOverNodes(count, nodes) {
    const perNode = Array.from({ length: nodes }, () => 0);
    for (let index = 0; index < count; index += 1) perNode[index % nodes] += 1;
    return perNode;
}

function addNode(nodesPerZone, zoneIndex) {
    const copy = nodesPerZone.slice();
    copy[zoneIndex] += 1;
    return copy;
}

function pairDesign(seed, baseWorld, family) {
    const topology = baseWorld.topology;
    const rng = new Rng(seed ^ 0x9e3779b9);
    let targetZone = rng.int(topology.zones);
    const nodesPerZone = defaultNodesPerZone(topology);
    const balanced = balancedPodsPerZone(topology.initialReplicas, topology.zones);
    const slots = slotsPerNode(topology);
    const otherZone = (targetZone + 1) % topology.zones;
    let placementA;
    let placementB;
    let roles;
    let infeasibleReason = null;
    if (family === 'capacity-distribution') {
        placementA = { nodesPerZone: addNode(nodesPerZone, otherZone), podsPerZone: balanced };
        placementB = { nodesPerZone: addNode(nodesPerZone, targetZone), podsPerZone: balanced };
        roles = { A: 'spare-outside-target-zone', B: 'spare-inside-target-zone' };
    } else if (family === 'node-concentration') {
        // Both members: identical nodes (target zone gets a second node) and
        // identical per-zone counts; the target zone's pods are spread over
        // its two nodes (A) or stacked on the first one (B). Spreading needs at
        // least two pods in the target zone, so the zone with the most pods is
        // used and a topology with one pod per zone is declared infeasible.
        if (balanced[targetZone] < 2) targetZone = balanced.indexOf(Math.max(...balanced));
        if (balanced[targetZone] < 2) infeasibleReason = 'fewer than two pods in every zone';
        const shared = addNode(nodesPerZone, targetZone);
        const zoneOfNode = nodeZoneIndexes(shared);
        const perZoneNodes = shared.map((count) => count);
        const buildPodsPerNode = (stack) => {
            const perNode = [];
            let cursor = 0;
            perZoneNodes.forEach((count, zoneIndex) => {
                const pods = balanced[zoneIndex];
                const local = zoneIndex === targetZone && stack
                    ? [Math.min(pods, slots), ...Array.from({ length: count - 1 }, () => 0)]
                    : spreadOverNodes(pods, count);
                if (zoneIndex === targetZone && stack && pods > slots) local[1] += pods - slots;
                perNode.push(...local);
                cursor += count;
            });
            void zoneOfNode;
            void cursor;
            return perNode;
        };
        placementA = { nodesPerZone: shared, podsPerNode: buildPodsPerNode(false) };
        placementB = { nodesPerZone: shared, podsPerNode: buildPodsPerNode(true) };
        roles = { A: 'spread-within-target-zone', B: 'stacked-on-target-node' };
    } else if (family === 'readiness-wiring' || family === 'readiness-drain') {
        // k pods start not-ready. A keeps them inside the target zone (the
        // zone that will degrade, or the node that will be drained), so the
        // intervention removes no ready endpoint; B keeps them elsewhere.
        // Never start below the service floor: that would violate before the
        // intervention and make the pair meaningless.
        const k = Math.min(2, balanced[targetZone], balanced[otherZone],
            topology.initialReplicas - topology.serviceMinimumReady);
        if (k < 1) infeasibleReason = 'no readiness slack above the service floor';
        const startingA = Array.from({ length: topology.zones }, () => 0);
        const startingB = Array.from({ length: topology.zones }, () => 0);
        startingA[targetZone] = Math.max(0, k);
        if (k >= 1) {
            if (topology.zones === 2 || k === 1) startingB[otherZone] = k;
            else { startingB[otherZone] = 1; startingB[(targetZone + 2) % topology.zones] = k - 1; }
        }
        placementA = { nodesPerZone, podsPerZone: balanced, startingPerZone: startingA };
        placementB = { nodesPerZone, podsPerZone: balanced, startingPerZone: startingB };
        roles = { A: 'unready-pods-inside-target', B: 'unready-pods-outside-target' };
    } else {
        placementA = { nodesPerZone, podsPerZone: balanced };
        placementB = { nodesPerZone, podsPerZone: concentratedPodsPerZone(topology, nodesPerZone, targetZone) };
        roles = { A: 'balanced', B: 'concentrated' };
    }
    const otherZoneFinal = (targetZone + 1) % topology.zones;
    void otherZoneFinal;
    const targetNode = `node-${String.fromCharCode(97 + targetZone)}`;
    const intervention = ['node-placement', 'node-concentration'].includes(family)
        ? { type: CLOUD_FAULT.NODE_CRASH, nodeId: targetNode }
        : ['pdb-placement', 'readiness-drain'].includes(family)
            ? { type: CLOUD_ACTION.DRAIN_NODE, nodeId: targetNode }
            : { type: CLOUD_FAULT.ZONE_DEGRADED, zoneId: zoneName(targetZone) };
    const namesA = nodeNameList(topology, placementA.nodesPerZone).map((item) => item.name);
    const namesB = new Set(nodeNameList(topology, placementB.nodesPerZone).map((item) => item.name));
    return stable({
        family,
        relationalOnly: RELATIONAL_ONLY_FAMILIES.includes(family),
        infeasibleReason,
        intervention,
        placements: { A: placementA, B: placementB },
        roles,
        sharedNodeNames: namesA.filter((name) => namesB.has(name)),
        targetZone,
    });
}

function variantWorld(baseWorld, placement, role) {
    const normalized = normalizePlacement(baseWorld.topology, placement);
    return stable({
        ...baseWorld,
        placement: normalized,
        placementConcentration: placementConcentration(normalized.podsPerZone),
        placementKind: `pair-${role}`,
        spareNodeZone: null,
    });
}

function featureMultisets(graph) {
    const buckets = {};
    for (const node of graph.nodes) {
        buckets[node.type] = buckets[node.type] || [];
        const features = { ...node.features };
        // Service endpoint IDs and node zone IDs name other nodes; they are
        // identity, not aggregate state, and are already excluded from tensors.
        delete features.endpointPodIds;
        delete features.zone;
        buckets[node.type].push(JSON.stringify(stable(features)));
    }
    for (const list of Object.values(buckets)) list.sort();
    return buckets;
}

function edgeDifferences(left, right) {
    const types = new Set([...left.edges, ...right.edges].map((edge) => edge.type));
    const serialize = (graph, type) => JSON.stringify(graph.edges.filter((edge) => edge.type === type));
    return [...types].filter((type) => serialize(left, type) !== serialize(right, type)).sort();
}

// aggregateFeatureDelta: per resource type, whether the multiset of node
// feature vectors differs (a flat pooled model can only see these).
// graphStructuralDelta: which relation types are wired differently.
function comparePairStates(left, right) {
    const leftSets = featureMultisets(left);
    const rightSets = featureMultisets(right);
    const types = [...new Set([...Object.keys(leftSets), ...Object.keys(rightSets)])].sort();
    const differingNodeTypes = types.filter((type) => (
        JSON.stringify(leftSets[type] || []) !== JSON.stringify(rightSets[type] || [])
    ));
    const differingEdgeTypes = edgeDifferences(left, right);
    // Identical per-type multisets of node-feature vectors imply identical
    // inputs to any permutation-invariant pooling (the pooled MLP's typed
    // mean/min/max/sum), independent of the ordering by ID.
    const pooledInputsIdentical = differingNodeTypes.length === 0;
    const digest = (sets) => Object.fromEntries(Object.entries(sets).map(([type, list]) => [type,
        require('node:crypto').createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 16)]));
    return {
        aggregateMatched: pooledInputsIdentical,
        pooledInputsIdentical,
        aggregateFeatureDelta: { matched: pooledInputsIdentical, differingNodeTypes,
            multisetDigests: { control: digest(leftSets), treated: digest(rightSets) } },
        graphStructuralDelta: { differingEdgeTypes, edgeCounts: { control: left.edges.length, treated: right.edges.length } },
        differingEdgeTypes,
    };
}

/**
 * Pairwise ranking over discordant pairs: the model is correct when it scores
 * the simulator-unsafe member above the simulator-safe member. Concordant pairs
 * carry no ranking truth and are counted rather than scored.
 */
function pairwiseRanking(pairs, scoreOf, truth = 'trajectory') {
    const perFamily = {};
    const overall = { discordant: 0, concordant: 0, invalid: 0, correct: 0, ties: 0, marginSum: 0,
        labels: [], scores: [] };
    for (const pair of pairs) {
        const family = perFamily[pair.family] = perFamily[pair.family]
            || { discordant: 0, concordant: 0, invalid: 0, correct: 0, ties: 0, marginSum: 0, labels: [], scores: [] };
        const buckets = [family, overall];
        if (!pair.valid) { buckets.forEach((bucket) => { bucket.invalid += 1; }); continue; }
        const unsafeA = truth === 'trajectory' ? pair.truth.A.unsafe : pair.truth.A.horizons['5'];
        const unsafeB = truth === 'trajectory' ? pair.truth.B.unsafe : pair.truth.B.horizons['5'];
        if (unsafeA === unsafeB) { buckets.forEach((bucket) => { bucket.concordant += 1; }); continue; }
        const scoreA = scoreOf(pair.records.A);
        const scoreB = scoreOf(pair.records.B);
        const unsafeScore = unsafeB ? scoreB : scoreA;
        const safeScore = unsafeB ? scoreA : scoreB;
        for (const bucket of buckets) {
            bucket.discordant += 1;
            if (unsafeScore > safeScore) bucket.correct += 1;
            else if (unsafeScore === safeScore) bucket.ties += 1;
            bucket.marginSum += unsafeScore - safeScore;
            bucket.labels.push(true, false);
            bucket.scores.push(unsafeScore, safeScore);
        }
    }
    const finish = (bucket) => stable({
        discordantPairs: bucket.discordant,
        concordantPairs: bucket.concordant,
        invalidPairs: bucket.invalid,
        correct: bucket.correct,
        ties: bucket.ties,
        strictAccuracy: bucket.discordant ? bucket.correct / bucket.discordant : null,
        tieAwareAccuracy: bucket.discordant ? (bucket.correct + 0.5 * bucket.ties) / bucket.discordant : null,
        meanMargin: bucket.discordant ? bucket.marginSum / bucket.discordant : null,
        pairAuroc: bucket.discordant ? areaUnderRoc(bucket.labels, bucket.scores) : null,
        randomBaselineAccuracy: 0.5,
    });
    return stable({
        truth,
        overall: finish(overall),
        families: Object.fromEntries(Object.entries(perFamily).map(([name, bucket]) => [name, finish(bucket)])),
    });
}

module.exports = {
    FAMILY_DESCRIPTIONS,
    PAIR_FAMILIES,
    RELATIONAL_ONLY_FAMILIES,
    comparePairStates,
    pairDesign,
    pairwiseRanking,
    variantWorld,
};
