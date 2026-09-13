'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { sameCloudFailure } = require('../packages/cloudproof/invariants');
const { ACTION_TYPES, FAULT_TYPES } = require('./cloud-actions');
const { CLOUD_MUTANTS } = require('./cloud-mutants');
const { runCloudSchedule } = require('./cloud-runtime');
const { materializeCloudSchedule } = require('./cloud-schedule');
const {
    benchmarkCloudProof,
    replayCloudArtifact,
    safeCampaign,
    searchCloudSchedules,
} = require('./cloud-search');
const { replayOnKind } = require('../tools/cloudproof-kind-replay');

test('cloud action and fault vocabularies stay deliberately bounded', () => {
    assert.deepEqual(ACTION_TYPES, [
        'cloud.action.roll-out',
        'cloud.action.roll-back',
        'cloud.action.scale',
        'cloud.action.drain-node',
        'cloud.action.recover-node',
        'cloud.action.advance-time',
        'cloud.action.traffic-spike',
    ]);
    assert.deepEqual(FAULT_TYPES, [
        'cloud.fault.node-crash',
        'cloud.fault.node-drain',
        'cloud.fault.zone-degraded',
        'cloud.fault.readiness-delay',
        'cloud.fault.image-pull-delay',
        'cloud.fault.hpa-stale-metric',
        'cloud.fault.endpoint-propagation-delay',
        'cloud.fault.controller-restart',
    ]);
});

test('same seed produces a byte-identical graph transition trace', async () => {
    const firstSchedule = materializeCloudSchedule(1337, { scenario: 'flagship', noise: 12 });
    const secondSchedule = materializeCloudSchedule(1337, { scenario: 'flagship', noise: 12 });
    assert.deepEqual(firstSchedule, secondSchedule);
    const first = await runCloudSchedule(firstSchedule);
    const second = await runCloudSchedule(secondSchedule);
    assert.deepEqual(first.graphTransitions, second.graphTransitions);
    assert.equal(first.replayFingerprint, second.replayFingerprint);
});

test('risk-guided generation injects state and candidate actions through the scorer interface', () => {
    const calls = [];
    const schedule = materializeCloudSchedule(1337, {
        scenario: 'safe',
        noise: 1,
        riskScorer: {
            score(state, candidateAction) {
                calls.push({ state: state.kind, action: candidateAction.type });
                return candidateAction.type === 'cloud.controller.hpa' ? 1 : 0;
            },
        },
    });
    assert.equal(schedule.strategy, 'risk-guided');
    assert.ok(calls.length > 1);
    assert.ok(calls.every((call) => call.state === 'cloudproof.cluster-state'));
    assert.equal(schedule.actions.at(-1).type, 'cloud.controller.hpa');
});

test('flagship 20+ action failure shrinks below ten with the exact fingerprint', async () => {
    const outcome = await searchCloudSchedules({
        scenario: 'flagship', mutant: 'correct', seed: 1337, runs: 1, noise: 12, artifacts: false,
    });
    assert.equal(outcome.found, true);
    assert.ok(outcome.original.schedule.actions.length >= 20);
    assert.ok(outcome.minimized.schedule.actions.length < 10);
    assert.equal(sameCloudFailure(outcome.original, outcome.minimized), true);
    const replay = await runCloudSchedule(outcome.minimized.schedule);
    assert.equal(replay.replayFingerprint, outcome.minimized.replayFingerprint);
});

test('search kills all three controller mutants with their intended failure classes', async () => {
    for (const mutant of CLOUD_MUTANTS) {
        const outcome = await searchCloudSchedules({ mutant: mutant.id, seed: 1337, runs: 1,
            artifacts: false });
        assert.equal(outcome.found, true, mutant.id);
        assert.equal(outcome.minimized.failure.violationClass, mutant.expectedViolationClass, mutant.id);
        assert.equal(sameCloudFailure(outcome.original, outcome.minimized), true, mutant.id);
    }
});

test('correct controller model passes at least 1,000 generated schedules', async () => {
    const campaign = await safeCampaign({ seed: 12000, runs: 1000 });
    assert.equal(campaign.schedules, 1000);
    assert.equal(campaign.violations, 0);
});

test('artifact, graph dataset, replay, and kind dry-run remain connected', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudproof-artifact-'));
    const file = path.join(directory, 'failure.json');
    try {
        const outcome = await searchCloudSchedules({
            scenario: 'flagship', seed: 1337, runs: 1, noise: 12, artifacts: true, out: file,
        });
        assert.equal(fs.existsSync(outcome.file), true);
        assert.equal(fs.existsSync(outcome.datasetFile), true);
        assert.match(fs.readFileSync(outcome.datasetFile, 'utf8'), /"nextState"/);
        const replay = await replayCloudArtifact(file);
        assert.equal(replay.sameFailure, true);
        assert.equal(replay.byteIdentical, true);
        const dryRun = await replayOnKind(file, { dryRun: true });
        assert.equal(dryRun.predicted.failureClass, outcome.minimized.failure.violationClass);
        assert.deepEqual(dryRun.commands, outcome.minimized.schedule.actions.map((action) => action.type));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('benchmark reports all acceptance measurements reproducibly', async () => {
    const result = await benchmarkCloudProof({ runs: 1, seed: 1337, noise: 12 });
    assert.deepEqual(result.mutantKillRate, { killed: 3, total: 3, ratio: 1 });
    assert.equal(result.correctedModel.schedules, 1000);
    assert.equal(result.correctedModel.violations, 0);
    assert.equal(result.flagship.found, true);
    assert.ok(result.flagship.originalActions >= 20);
    assert.ok(result.flagship.minimizedActions < 10);
    assert.equal(result.flagship.exactFingerprint, true);
    assert.ok(result.mutants.every((mutant) => mutant.byteIdenticalReplay));
    assert.equal(typeof result.riskBaseline.evaluation.logistic.auroc, 'number');
});
