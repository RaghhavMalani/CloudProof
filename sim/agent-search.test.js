'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { sameFailure } = require('../packages/simulator/agent-invariants');
const { ACTION_TYPES, AGENT_ACTION, AGENT_FAULT, FAULT_TYPES } = require('./agent-actions');
const { MUTANTS } = require('./agent-mutants');
const { runAgentSchedule } = require('./agent-runtime-sim');
const { materializeAgentSchedule } = require('./agent-schedule');
const {
    benchmarkAgentSearch,
    parseArgs,
    regressionTestSource,
    replayArtifact,
    searchAgentSchedules,
} = require('./agent-search');

test('the agent action language stays deliberately small and explicit', () => {
    assert.deepEqual(ACTION_TYPES, [
        'agent.advance',
        'agent.effect.authorize',
        'agent.effect.dispatch',
        'agent.effect.reconcile',
        'agent.effect.result',
        'agent.effect.commit',
        'agent.snapshot.approve',
    ]);
    assert.deepEqual(FAULT_TYPES, [
        'fault.worker.crash',
        'fault.leader.crash',
        'fault.tool.response.drop',
        'fault.tool.response.delay',
        'fault.worker.race',
        'fault.policy.deploy',
        'fault.quorum.lose',
        'fault.quorum.restore',
    ]);
});

test('seed generation materializes a concrete schedule and replay samples no randomness', () => {
    const first = materializeAgentSchedule(1337, { workflow: 'refund', noise: 5 });
    const again = materializeAgentSchedule(1337, { workflow: 'refund', noise: 5 });
    const different = materializeAgentSchedule(1338, { workflow: 'refund', noise: 5 });
    assert.deepEqual(first, again);
    assert.notDeepEqual(first.actions, different.actions);

    const original = runAgentSchedule(first, { mutant: 'correct' });
    const replay = runAgentSchedule(JSON.parse(JSON.stringify(first)), { mutant: 'correct' });
    assert.equal(replay.replayFingerprint, original.replayFingerprint);
    assert.deepEqual(replay.trace, original.trace);
    assert.deepEqual(replay.finalState, original.finalState);
});

test('the correct Stage 4 runtime remains safe across a covered generated campaign', async () => {
    const outcome = await searchAgentSchedules({
        workflow: 'refund', mutant: 'correct', strategy: 'coverage', seed: 1, runs: 250,
        shrink: false, artifacts: false,
    });
    assert.equal(outcome.found, false);
    assert.deepEqual(outcome.coverage.target, { covered: 15, total: 15, ratio: 1 });
    assert.equal(outcome.coverage.failureClasses.length, 0);
});

test('all agent mutants are discovered, exactly classified, replayed, and minimized', async () => {
    const expectedSizes = {
        'blind-retry': 5,
        'dispatch-before-intent': 1,
        'no-worker-fence': 3,
        'volatile-semantic-conflict': 3,
        'result-forgotten-on-resume': 4,
    };
    for (const mutant of MUTANTS) {
        const outcome = await searchAgentSchedules({
            workflow: 'refund', mutant: mutant.id, strategy: 'coverage', seed: 1, runs: 100,
            artifacts: false, maxEvaluations: 250,
        });
        assert.equal(outcome.found, true, mutant.id);
        assert.equal(outcome.minimized.failure.violationClass, mutant.expectedViolationClass, mutant.id);
        assert.ok(sameFailure(outcome.original, outcome.minimized), mutant.id);
        assert.equal(outcome.minimized.schedule.actions.length, expectedSizes[mutant.id], mutant.id);
        const replay = runAgentSchedule(outcome.minimized.schedule, { mutant: mutant.id });
        assert.equal(replay.replayFingerprint, outcome.minimized.replayFingerprint, mutant.id);
        if (mutant.id === 'blind-retry') {
            const safeReplay = runAgentSchedule(outcome.minimized.schedule, { mutant: 'correct' });
            assert.equal(safeReplay.ok, true, 'the safe runtime must suppress the exact five-action retry');
            assert.equal(safeReplay.metrics.observableEffects, 1);
        }
    }
});

test('failure identity rejects a different class or subject during shrinking', () => {
    const original = {
        failure: {
            fingerprint: {
                invariant: 'agent.effect.at-most-once',
                violationClass: 'DUPLICATE_OBSERVABLE_EFFECT',
                executionId: 'refund:order_4821',
                effectId: 'effect:a',
            },
        },
    };
    assert.equal(sameFailure(original, JSON.parse(JSON.stringify(original))), true);
    assert.equal(sameFailure(original, {
        failure: { fingerprint: { ...original.failure.fingerprint, effectId: 'effect:b' } },
    }), false);
    assert.equal(sameFailure(original, {
        failure: { fingerprint: { ...original.failure.fingerprint, violationClass: 'UNTRACKED_EXTERNAL_EFFECT' } },
    }), false);
});

test('failure artifacts replay byte-identically and include a runnable regression source', async () => {
    const directory = path.join(__dirname, '.agent-search-test-artifacts');
    const artifactFile = path.join(directory, 'refund-test.json');
    try {
        const outcome = await searchAgentSchedules({
            workflow: 'refund', mutant: 'blind-retry', strategy: 'coverage', seed: 1, runs: 20,
            artifacts: true, out: artifactFile,
        });
        assert.equal(outcome.found, true);
        assert.equal(fs.existsSync(outcome.file), true);
        assert.equal(fs.existsSync(outcome.regressionFile), true);
        const replay = await replayArtifact(outcome.file);
        assert.equal(replay.sameFailure, true);
        assert.equal(replay.byteIdentical, true);
        assert.doesNotThrow(() => new Function(fs.readFileSync(outcome.regressionFile, 'utf8')));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('the benchmark kills every mutant and reports zero correct-runtime violations', async () => {
    const benchmark = await benchmarkAgentSearch({ seed: 1, runs: 100, maxEvaluations: 250 });
    assert.deepEqual(benchmark.mutantKillRate, { killed: 5, total: 5, ratio: 1 });
    assert.equal(benchmark.correctRuntime.violations, 0);
    assert.ok(benchmark.rows.every((row) => row.found && row.correctlyClassified));
    assert.ok(benchmark.rows.every((row) => row.originalActions >= row.minimizedActions));
});

test('the CLI treats seed as the first schedule rather than reducing runs to one', () => {
    const options = parseArgs([
        '--workflow', 'refund', '--runs', '10000', '--seed', '1337',
        '--strategy', 'random', '--mutant', 'blind-retry', '--no-shrink',
    ]);
    assert.equal(options.runs, 10000);
    assert.equal(options.seed, 1337);
    assert.equal(options.strategy, 'random');
    assert.equal(options.shrink, false);
});

test('generated regression source is syntactically complete', () => {
    const source = regressionTestSource({
        artifactName: 'refund-1337.json',
        runtimeModule: '../../sim/agent-runtime-sim',
        invariantModule: '../../packages/simulator/agent-invariants',
    });
    assert.doesNotThrow(() => new Function(source));
    assert.match(source, /replayFingerprint/);
    assert.match(source, /sameFailure/);
    assert.equal(AGENT_ACTION.ADVANCE, 'agent.advance');
    assert.equal(AGENT_FAULT.CRASH_WORKER, 'fault.worker.crash');
});
