'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    RiskBaseline,
    evaluateRiskBaseline,
    evaluateScores,
    exportTransitionDataset,
} = require('./transition-dataset');
const { runCloudSchedule } = require('../../sim/cloud-runtime');
const { materializeCloudSchedule } = require('../../sim/cloud-schedule');

test('every transition is a graph-learning record and exports deterministic JSONL', async () => {
    const schedule = materializeCloudSchedule(1337, { scenario: 'flagship', noise: 0 });
    const first = await runCloudSchedule(schedule);
    const second = await runCloudSchedule(JSON.parse(JSON.stringify(schedule)));
    assert.deepEqual(first.graphTransitions, second.graphTransitions);
    assert.equal(first.replayFingerprint, second.replayFingerprint);
    assert.ok(first.graphTransitions.length >= schedule.actions.length);
    for (const row of first.graphTransitions) {
        assert.equal(row.state.kind, 'cloudproof.infrastructure-graph');
        assert.equal(row.nextState.kind, 'cloudproof.infrastructure-graph');
        assert.equal(typeof row.action.type, 'string');
        assert.equal(typeof row.labels.sloViolationWithin1000ms, 'boolean');
        assert.equal(typeof row.labels.minReadyReplicas, 'number');
    }

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudproof-dataset-'));
    try {
        const left = exportTransitionDataset(first.graphTransitions, path.join(directory, 'left.jsonl'));
        const right = exportTransitionDataset(second.graphTransitions, path.join(directory, 'right.jsonl'));
        assert.equal(fs.readFileSync(left, 'utf8'), fs.readFileSync(right, 'utf8'));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('logistic risk baseline trains and evaluates reproducibly', async () => {
    const safe = await runCloudSchedule(materializeCloudSchedule(9001, { scenario: 'safe', noise: 0 }));
    const failure = await runCloudSchedule(materializeCloudSchedule(1337, { scenario: 'flagship', noise: 0 }));
    const records = [...safe.graphTransitions, ...failure.graphTransitions];
    const first = new RiskBaseline().train(records, { iterations: 50 });
    const second = new RiskBaseline().train(records, { iterations: 50 });
    assert.deepEqual(first.export(), second.export());
    const evaluation = evaluateRiskBaseline(first, records, { randomSeed: 1337 });
    assert.deepEqual(evaluation, evaluateRiskBaseline(second, records, { randomSeed: 1337 }));
    assert.equal(typeof evaluation.logistic.brierScore, 'number');
    assert.equal(evaluation.logistic.calibration.length, 5);
    assert.equal(typeof first.score(failure.finalState, { type: 'cloud.action.drain-node' }), 'number');
});

test('ranking and calibration metrics handle perfect and tied probabilities', () => {
    const records = [true, false].map((label) => ({
        labels: { sloViolationWithinKTransitions: label },
    }));
    const perfect = evaluateScores(records, [1, 0]);
    assert.equal(perfect.auroc, 1);
    assert.equal(perfect.auprc, 1);
    assert.equal(perfect.brierScore, 0);
    assert.equal(perfect.expectedCalibrationError, 0);
    const tied = evaluateScores(records, [0.5, 0.5]);
    assert.equal(tied.auroc, 0.5);
    assert.equal(tied.auprc, 0.5);
});
