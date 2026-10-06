'use strict';

/**
 * Mutation testing for the Phase IV-A correctness checks.
 *
 * A fault campaign that reports zero violations proves something only if it
 * would have reported a violation for a broken implementation. Each mutant in
 * perf-mutants.js is one plausible optimization bug; this file asserts the real
 * engine passes every killer and that every mutant is killed by at least one.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { MUTANTS, KILLERS, applyMutant } = require('./perf-mutants');

// Killers run cheapest first; a mutant needs only one kill, so the mutant
// tests stop at the first (the real engine is always run against all).
async function runKillers({ stopOnKill = false } = {}) {
    const outcomes = {};
    for (const [name, killer] of Object.entries(KILLERS)) {
        const log = console.log;
        console.log = () => {};
        try {
            outcomes[name] = await killer();
        } finally {
            console.log = log;
        }
        if (stopOnKill && !outcomes[name].ok) break;
    }
    return outcomes;
}

test('the real engine passes every killer', async () => {
    const outcomes = await runKillers();
    for (const [name, outcome] of Object.entries(outcomes)) {
        assert.equal(outcome.ok, true, `${name}: ${outcome.reason}`);
    }
});

for (const name of Object.keys(MUTANTS)) {
    test(`mutant "${name}" is killed`, async () => {
        const restore = applyMutant(name);
        let outcomes;
        try {
            outcomes = await runKillers({ stopOnKill: true });
        } finally {
            restore();
        }
        const killedBy = Object.entries(outcomes).filter(([, o]) => !o.ok).map(([k, o]) => `${k} (${o.reason})`);
        assert.ok(killedBy.length > 0, `${name} survived every killer`);
    });
}
