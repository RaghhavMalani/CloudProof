'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs: parseBenchmarkArgs, scorerName } = require('./cloudproof-gnn-benchmark');
const { buildPair, parseArgs: parseCounterfactualArgs } = require('./cloudproof-counterfactuals');
const { labelSchedule, parseArgs: parseHorizonArgs } = require('./cloudproof-horizon-labels');
const { materializeCloudSchedule } = require('../sim/cloud-schedule');

test('benchmark accepts every explicit deterministic edge-destruction mode', () => {
    const modes = 'full,randomized-edges,collapsed-edge-types,no-edges,random-relation-labels';
    assert.deepEqual(parseBenchmarkArgs(['--edge-modes', modes]).edgeModes, modes.split(','));
    assert.equal(scorerName('full'), 'gnn');
    assert.equal(scorerName('randomized-edges'), 'gnnRandomizedEdges');
});

test('counterfactual CLI enforces the requested 100-500 pair range', () => {
    assert.equal(parseCounterfactualArgs(['--pairs', '100']).pairs, 100);
    assert.throws(() => parseCounterfactualArgs(['--pairs', '99']), /\[100, 500\]/);
});

test('matched topology pair changes only RUNS_ON edges and deterministic truth', async () => {
    const rows = await buildPair(0, 71000);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].variant, 'balanced');
    assert.equal(rows[0].labels.sloViolationWithinKTransitions, false);
    assert.equal(rows[1].variant, 'concentrated');
    assert.equal(rows[1].labels.sloViolationWithinKTransitions, true);
});

test('horizon replay changes labels without changing transitions', async () => {
    const schedule = materializeCloudSchedule(991, {
        scenario: 'safe',
        strategy: 'research-corpus',
    });
    schedule.scenarioId = 'horizon-test';
    const rows = await labelSchedule({ scenarioId: schedule.scenarioId, split: 'validation', schedule }, [1, 3]);
    assert.ok(rows.length > 0);
    assert.deepEqual(Object.keys(rows[0].labels), ['1', '3']);
    assert.deepEqual(parseHorizonArgs(['--horizons', '1,3']).horizons, [1, 3]);
});
