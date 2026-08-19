'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    MUTANTS,
    evaluateAll,
    evaluateMutant,
    runSchedule,
} = require('./bug-museum');

test('the searcher rediscovers every seeded mutant and corrected replays pass', () => {
    const evaluation = evaluateAll({ seed: 42 });

    assert.equal(evaluation.discovered, 10);
    assert.equal(evaluation.total, 10);
    assert.equal(evaluation.correctedPassed, 10);
    assert.equal(evaluation.medianReduction, 84);
});

test('shrinking preserves each exact predicate and removes schedule noise', () => {
    for (const mutant of MUTANTS) {
        const result = evaluateMutant(mutant.id, { seed: 91 });
        assert.equal(result.minimized.target, mutant.signature);
        assert.equal(result.minimized.result.failure.signature, mutant.signature);
        assert.equal(result.minimized.stats.actionsBefore, 25);
        assert.equal(result.minimized.stats.actionsAfter, 4);
        assert.equal(result.minimized.stats.reductionPercent, 84);
    }
});

test('mutant and corrected implementation replay the identical minimized schedule', () => {
    const result = evaluateMutant('stale-leader-read', { seed: 7 });
    const healthy = runSchedule('stale-leader-read', result.minimized.schedule, {
        mutationEnabled: false,
    });

    assert.equal(result.minimized.result.ok, false);
    assert.equal(healthy.ok, true);
    assert.deepEqual(
        healthy.schedule.actions.map((action) => action.id),
        result.minimized.schedule.actions.map((action) => action.id),
    );
    assert.ok(result.minimized.result.trace.events.some((event) => event.status === 'violation'));
    assert.ok(healthy.trace.events.some((event) => event.status === 'correction'));
});
