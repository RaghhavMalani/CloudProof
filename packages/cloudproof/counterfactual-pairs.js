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
    placementConcentration,
    zoneName,
} = require('./placement');
const { stable } = require('./state');
const { areaUnderRoc } = require('./transition-dataset');

const PAIR_FAMILIES = Object.freeze([
    'zone-placement',
    'node-placement',
    'pdb-placement',
    'capacity-distribution',
]);

const FAMILY_DESCRIPTIONS = Object.freeze({
    'zone-placement': 'balanced pods per zone versus pods concentrated in the zone that then degrades',
    'node-placement': 'balanced pods per zone versus pods concentrated in the zone whose first node then crashes',
    'pdb-placement': 'balanced pods per zone versus pods concentrated in the zone whose first node is then drained under the PDB',
    'capacity-distribution': 'identical pods; the one spare node sits outside versus inside the zone that then degrades',
});

function addNode(nodesPerZone, zoneIndex) {
    const copy = nodesPerZone.slice();
    copy[zoneIndex] += 1;
    return copy;
}

function pairDesign(seed, baseWorld, family) {
    const topology = baseWorld.topology;
    const rng = new Rng(seed ^ 0x9e3779b9);
    const targetZone = rng.int(topology.zones);
    const nodesPerZone = defaultNodesPerZone(topology);
    const balanced = balancedPodsPerZone(topology.initialReplicas, topology.zones);
    let placementA;
    let placementB;
    let roles;
    if (family === 'capacity-distribution') {
        placementA = { nodesPerZone: addNode(nodesPerZone, (targetZone + 1) % topology.zones), podsPerZone: balanced };
        placementB = { nodesPerZone: addNode(nodesPerZone, targetZone), podsPerZone: balanced };
        roles = { A: 'spare-outside-target-zone', B: 'spare-inside-target-zone' };
    } else {
        placementA = { nodesPerZone, podsPerZone: balanced };
        placementB = { nodesPerZone, podsPerZone: concentratedPodsPerZone(topology, nodesPerZone, targetZone) };
        roles = { A: 'balanced', B: 'concentrated' };
    }
    const targetNode = `node-${String.fromCharCode(97 + targetZone)}`;
    const intervention = family === 'node-placement'
        ? { type: CLOUD_FAULT.NODE_CRASH, nodeId: targetNode }
        : family === 'pdb-placement'
            ? { type: CLOUD_ACTION.DRAIN_NODE, nodeId: targetNode }
            : { type: CLOUD_FAULT.ZONE_DEGRADED, zoneId: zoneName(targetZone) };
    const namesA = nodeNameList(topology, placementA.nodesPerZone).map((item) => item.name);
    const namesB = new Set(nodeNameList(topology, placementB.nodesPerZone).map((item) => item.name));
    return stable({
        family,
        intervention,
        placements: { A: placementA, B: placementB },
        roles,
        sharedNodeNames: namesA.filter((name) => namesB.has(name)),
        targetZone,
    });
}

function variantWorld(baseWorld, placement, role) {
    return stable({
        ...baseWorld,
        placement,
        placementConcentration: placementConcentration(placement.podsPerZone),
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
    return {
        aggregateMatched: differingNodeTypes.length === 0,
        aggregateFeatureDelta: { matched: differingNodeTypes.length === 0, differingNodeTypes },
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
    comparePairStates,
    pairDesign,
    pairwiseRanking,
    variantWorld,
};
