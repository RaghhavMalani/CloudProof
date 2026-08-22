'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WORKLOADS, runWorkload } = require('./index');
const { BRIEFS, STEPS, briefFor, stepCopy } = require('./plain-english');

const BRIEF_FIELDS = ['headline', 'symptom', 'whoHitsThis', 'naive', 'rule'];

test('every workload has a brief, and every brief has a workload', () => {
    assert.deepEqual(Object.keys(BRIEFS).sort(), WORKLOADS.map((w) => w.id).sort());
    assert.deepEqual(Object.keys(STEPS).sort(), WORKLOADS.map((w) => w.id).sort());
});

test('briefs are complete and are written as sentences, not labels', () => {
    for (const workload of WORKLOADS) {
        const brief = briefFor(workload.id);
        for (const field of BRIEF_FIELDS) {
            const value = brief[field];
            assert.equal(typeof value, 'string', `${workload.id}.${field} must exist`);
            assert.ok(value.length > 20, `${workload.id}.${field} is too short to explain anything`);
        }
        // The headline is the one line a reader sees before deciding whether to
        // care. If it does not end in a full stop it is a label, not a claim.
        assert.match(brief.headline, /[.!?]$/, `${workload.id} headline must be a sentence`);
    }
});

test('every event a workload can emit has plain-English copy', () => {
    // The failure this prevents: the deck previously had plain copy for the
    // payment workload only, and the other nine silently fell through to the
    // engineering detail string. Nothing failed, so nobody noticed.
    const missing = [];
    for (const workload of WORKLOADS) {
        const result = runWorkload(workload, { seed: 42 });
        for (const event of result.events) {
            if (event.type === 'invariant.checked') continue;
            const label = event.data.label;
            if (!stepCopy(workload.id, label)) missing.push(`${workload.id} · ${label}`);
        }
    }
    assert.deepEqual(missing, [], `no plain-English copy for:\n  ${missing.join('\n  ')}`);
});

test('no brief or step copy is left over from a deleted event', () => {
    // The other direction: copy for a label the workload no longer emits is
    // dead weight that reads as coverage.
    const orphans = [];
    for (const workload of WORKLOADS) {
        const emitted = new Set(runWorkload(workload, { seed: 42 })
            .events.filter((event) => event.type !== 'invariant.checked')
            .map((event) => event.data.label));
        for (const label of Object.keys(STEPS[workload.id])) {
            if (!emitted.has(label)) orphans.push(`${workload.id} · ${label}`);
        }
    }
    assert.deepEqual(orphans, [], `copy for events that are never emitted:\n  ${orphans.join('\n  ')}`);
});

test('event labels are unique within a workload, which is what makes them usable as keys', () => {
    for (const workload of WORKLOADS) {
        const labels = runWorkload(workload, { seed: 42 })
            .events.filter((event) => event.type !== 'invariant.checked')
            .map((event) => event.data.label);
        const duplicates = labels.filter((label, index) => labels.indexOf(label) !== index);
        assert.deepEqual([...new Set(duplicates)], [],
            `${workload.id} reuses a label, so its copy would be ambiguous`);
    }
});

test('the copy avoids the vocabulary a first-time reader does not have', () => {
    // Not a style rule for its own sake. Every term below appeared in the copy
    // this file replaced, and each one requires the reader to already know the
    // answer. Terms are allowed in the `rule` field, which is where the precise
    // statement belongs — but not in `headline` or `symptom`, which have to
    // land on someone who has never read the Raft paper.
    const jargon = /\b(invariant|linearizab|quorum|idempoten|commit index|state machine|epoch|CRDT|fencing|monotonic)/i;
    for (const workload of WORKLOADS) {
        const brief = briefFor(workload.id);
        for (const field of ['headline', 'symptom']) {
            assert.doesNotMatch(brief[field], jargon,
                `${workload.id}.${field} uses vocabulary the reader does not have yet`);
        }
    }
});
