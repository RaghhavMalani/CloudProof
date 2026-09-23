'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { sameMultiAgentFailure } = require('../packages/simulator/multi-agent-invariants');
const { MULTI_AGENT_MUTANTS } = require('./multi-agent-mutants');
const { runMultiAgentSchedule } = require('./multi-agent-runtime-sim');
const { materializeMultiAgentSchedule } = require('./multi-agent-schedule');
const {
    benchmarkMultiAgentRaces,
    replayMultiAgentArtifact,
    searchMultiAgentSchedules,
} = require('./multi-agent-search');

test('materialized schedule contains three autonomous workflows and concrete scheduler noise', () => {
    const schedule = materializeMultiAgentSchedule(1337, {
        strategy: 'coverage',
        runtime: 'unfenced-compensation',
        targetAgents: ['refund-agent', 'customer-recovery-agent'],
    });
    assert.equal(schedule.actions.length, 29);
    assert.deepEqual(
        [...new Set(schedule.actions.map((action) => action.agentId).filter(Boolean))].sort(),
        ['customer-recovery-agent', 'fraud-review-agent', 'refund-agent'],
    );
    assert.equal(schedule.actions.filter((action) => action.type === 'multi-agent.yield').length, 20);
});

test('search kills every race mutant and shrinks each failure to its six causal actions', async () => {
    for (const mutant of MULTI_AGENT_MUTANTS) {
        const outcome = await searchMultiAgentSchedules({
            mutant: mutant.id,
            strategy: 'coverage',
            seed: 1337,
            runs: 10,
            artifacts: false,
        });
        assert.equal(outcome.found, true, mutant.id);
        assert.equal(outcome.original.schedule.actions.length, 29, mutant.id);
        assert.equal(outcome.minimized.schedule.actions.length, 6, mutant.id);
        assert.equal(outcome.minimized.failure.violationClass, mutant.expectedViolationClass, mutant.id);
        const replay = runMultiAgentSchedule(outcome.minimized.schedule, { mutant: mutant.id });
        assert.ok(sameMultiAgentFailure(outcome.minimized, replay), mutant.id);
        assert.equal(replay.replayFingerprint, outcome.minimized.replayFingerprint, mutant.id);
    }
});

test('corrected runtime converts the stale sixth action into REVALIDATE', () => {
    const schedule = materializeMultiAgentSchedule(1337, {
        strategy: 'coverage',
        runtime: 'correct',
        targetAgents: ['refund-agent', 'customer-recovery-agent'],
        noise: 0,
    });
    const result = runMultiAgentSchedule(schedule, { mutant: 'correct' });
    assert.equal(result.ok, true);
    assert.equal(result.finalState.resources['order:4821'].version, 18);
    assert.equal(result.finalState.resources['order:4821'].state.compensatedCents, 899900);
    assert.deepEqual(result.finalState.resources['order:4821'].state.terminalStates, ['REFUNDED']);
    assert.equal(result.finalState.conflicts.length, 1);
    assert.deepEqual(result.finalState.conflicts[0], {
        error: 'RESOURCE_VERSION_CONFLICT',
        agentId: 'customer-recovery-agent',
        executionId: 'customer-recovery-agent:order-4821',
        resourceId: 'order:4821',
        expectedVersion: 17,
        actualVersion: 18,
        decision: 'REVALIDATE',
    });
});

test('corrected runtime survives a substantial mixed-strategy campaign', () => {
    for (let offset = 0; offset < 2000; offset += 1) {
        const schedule = materializeMultiAgentSchedule(7000 + offset, {
            strategy: offset % 2 === 0 ? 'coverage' : 'random',
            runtime: 'correct',
        });
        const result = runMultiAgentSchedule(schedule, { mutant: 'correct' });
        assert.equal(result.ok, true, `seed ${7000 + offset}`);
    }
});

test('benchmark reports a perfect mutant kill rate and zero corrected-runtime violations', async () => {
    const benchmark = await benchmarkMultiAgentRaces({ runs: 10, seed: 1337 });
    assert.deepEqual(benchmark.mutantKillRate, { killed: 4, total: 4, ratio: 1 });
    assert.equal(benchmark.correctedRuntime.schedules, 1000);
    assert.equal(benchmark.correctedRuntime.violations, 0);
    assert.ok(benchmark.correctedRuntime.resourceVersionConflicts > 0);
    assert.ok(benchmark.mutants.every((mutant) => mutant.byteIdenticalReplay));
    assert.ok(benchmark.mutants.every((mutant) => mutant.minimizedActions === 6));
});

test('saved counterexample artifact replays byte-identically', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudproof-multi-agent-artifact-'));
    const file = path.join(directory, 'over-compensation.json');
    try {
        const outcome = await searchMultiAgentSchedules({
            mutant: 'unfenced-compensation',
            strategy: 'coverage',
            seed: 1337,
            runs: 10,
            artifacts: true,
            out: file,
        });
        assert.equal(outcome.file, path.resolve(file));
        const replay = await replayMultiAgentArtifact(file);
        assert.equal(replay.sameFailure, true);
        assert.equal(replay.byteIdentical, true);
        assert.equal(replay.result.failure.violationClass, 'OVER_COMPENSATION');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
