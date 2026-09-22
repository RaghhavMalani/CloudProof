'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractRiskFeatures, heuristicRiskScore } = require('../packages/cloudproof/transition-dataset');
const { RELATIONAL_ONLY_FAMILIES, comparePairStates } = require('../packages/cloudproof/counterfactual-pairs');
const { probeFeatureNames } = require('../packages/cloudproof/nuisance');
const { TOPOLOGY_CATALOG_V2 } = require('../packages/cloudproof/topology');
const { PAIR_FAMILY_MIX, executeCounterfactualPair } = require('./cloud-causal-corpus');
const { capIncidentClasses } = require('./cloud-causal-pipeline');
const { FIXTURE, buildFixtureLines } = require('../tools/cloudproof-relational-fixture');

async function firstFeasiblePair(family) {
    const slot = PAIR_FAMILY_MIX.indexOf(family);
    for (let offset = 0; offset < TOPOLOGY_CATALOG_V2.length; offset += 1) {
        const pair = await executeCounterfactualPair(slot * TOPOLOGY_CATALOG_V2.length + offset, {});
        if (pair.summary.valid && pair.summary.infeasibleReason === null) return { pair, index: slot * TOPOLOGY_CATALOG_V2.length + offset };
    }
    throw new Error(`no feasible ${family} pair`);
}

test('relational-only pairs keep pooled inputs and flat risk features identical while relations differ', async () => {
    for (const family of RELATIONAL_ONLY_FAMILIES) {
        const { pair } = await firstFeasiblePair(family);
        const [control, treated] = pair.lines.map((line) => JSON.parse(line));
        assert.equal(pair.summary.family, family);
        assert.equal(pair.summary.relationalOnly, true);
        assert.equal(pair.summary.pooledInputsIdentical, true, `${family}: pooled inputs differ`);
        assert.equal(pair.summary.flatSummaryIdentical, true, `${family}: flat features differ`);
        assert.deepEqual(extractRiskFeatures(control, control.action), extractRiskFeatures(treated, treated.action));
        assert.equal(heuristicRiskScore(control.state, control.action), heuristicRiskScore(treated.state, treated.action));
        assert.deepEqual(control.action, treated.action);
        const comparison = comparePairStates(control.state, treated.state);
        assert.deepEqual(comparison.aggregateFeatureDelta.differingNodeTypes, []);
        assert.ok(comparison.graphStructuralDelta.differingEdgeTypes.length >= 1, `${family}: no relation differs`);
        for (const type of comparison.graphStructuralDelta.differingEdgeTypes) {
            assert.ok(['RUNS_ON', 'ROUTES_TO', 'LOCATED_IN'].includes(type), `${family}: ${type}`);
        }
        // Same per-zone pod counts is the contract that hides the intervention
        // from zone-concentration statistics.
        const counts = (record) => {
            const graph = record.state;
            const zoneOf = new Map(graph.nodes.filter((node) => node.type === 'Node').map((node) => [node.id, node.features.zone]));
            const perZone = {};
            for (const edge of graph.edges.filter((item) => item.type === 'RUNS_ON')) {
                perZone[zoneOf.get(edge.to)] = (perZone[zoneOf.get(edge.to)] || 0) + 1;
            }
            return Object.values(perZone).sort();
        };
        if (family !== 'capacity-distribution') assert.deepEqual(counts(control), counts(treated));
    }
});

test('relational-only pair placements serialize deterministically and rerun byte-identically', async () => {
    const { index } = await firstFeasiblePair('readiness-wiring');
    const first = await executeCounterfactualPair(index, {});
    const second = await executeCounterfactualPair(index, {});
    assert.equal(first.lines.join('\n'), second.lines.join('\n'));
    const control = JSON.parse(first.lines[0]);
    assert.deepEqual(Object.keys(control.metadata.placement).sort(), ['nodesPerZone', 'podsPerZone', 'startingPerZone']);
    const treated = JSON.parse(first.lines[1]);
    assert.notDeepEqual(control.metadata.placement.startingPerZone, treated.metadata.placement.startingPerZone);
    assert.deepEqual(control.metadata.placement.podsPerZone, treated.metadata.placement.podsPerZone);
});

test('the committed relational fixture regenerates byte-identically', async () => {
    const lines = await buildFixtureLines();
    const committed = fs.readFileSync(path.join(__dirname, '..', FIXTURE), 'utf8');
    assert.equal(`${lines.join('\n')}\n`, committed);
    assert.equal(lines.length, RELATIONAL_ONLY_FAMILIES.length * 2);
});

test('ShortcutProbe features carry nothing derived from pair treatment', () => {
    const forbidden = new Set(['placement', 'role', 'pair', 'arm', 'starting', 'treated', 'control', 'intervention',
        'concentration', 'variant', 'outcome', 'incident']);
    const words = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+| /)
        .map((word) => word.toLowerCase()).filter(Boolean);
    for (const level of ['trajectory', 'transition', 'position']) {
        for (const name of probeFeatureNames(level)) {
            for (const word of words(name)) assert.ok(!forbidden.has(word), `${name} leaks ${word}`);
        }
    }
});

test('incident-class caps are post-hoc, deterministic, and drop the worst matches first', () => {
    const summaries = new Map();
    const pairs = [];
    for (let index = 0; index < 20; index += 1) {
        const cls = index < 14 ? 'SERVICE_CAPACITY_COLLAPSE' : 'ZONE_SURVIVABILITY_VIOLATION';
        summaries.set(`u${index}`, { incident: { violationClass: cls } });
        pairs.push({ matchId: `match-${String(index).padStart(3, '0')}`, unsafeTrajectoryId: `u${index}`,
            safeTrajectoryId: `s${index}`, distance: (index % 7) / 10 });
    }
    const first = capIncidentClasses(pairs, summaries, 0.5);
    const second = capIncidentClasses(pairs, summaries, 0.5);
    assert.deepEqual(first, second);
    assert.equal(first.before.SERVICE_CAPACITY_COLLAPSE, 14);
    assert.ok(first.after.SERVICE_CAPACITY_COLLAPSE / first.pairs.length <= 0.5 + 1e-9);
    assert.equal(first.after.ZONE_SURVIVABILITY_VIOLATION, 6);
    assert.equal(first.droppedPairs, first.dropped.SERVICE_CAPACITY_COLLAPSE);
    const kept = new Set(first.pairs.map((pair) => pair.matchId));
    // The largest-distance collapse pairs (distance 0.6) go before smaller ones.
    assert.ok(!kept.has('match-006') && !kept.has('match-013'));
    assert.deepEqual(capIncidentClasses(pairs, summaries, 1).pairs, pairs);
});
