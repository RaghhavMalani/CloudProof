'use strict';

/**
 * The IV-B.0 gate as tests (CLOUDPROOF-PHASE-IV-B.md §13): the deterministic
 * scenarios and a short seeded campaign on every engine profile, determinism,
 * and mutants proving each gate can fail. A gate that cannot go red proves
 * nothing.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const search = require('../../sim/multi-raft-search');
const { RaftNode } = require('../../replica/raft');
const { StateMachine } = require('../../replica/state-machine');
const { MemoryLogStore } = require('../../sim/cluster');
const { RangeStateMachine, INTERNAL_OPS } = require('./range-state-machine');

test('the simulator gate passes on every engine profile', async () => {
    const report = await search.runGate({ runs: 2 });
    for (const [profile, result] of Object.entries(report.profiles)) {
        for (const scenario of result.scenarios) assert.ok(scenario.ok, `${profile} ${scenario.scenario}`);
        assert.deepEqual(result.campaign.summary.failed, [], profile);
        assert.equal(result.campaign.summary.appliedMoreThanOnce, 0, profile);
        assert.equal(result.campaign.summary.missingAcknowledged, 0, profile);
        assert.equal(result.campaign.summary.staleEpochWritesAccepted, 0, profile);
    }
    assert.ok(report.ok);
});

test('independent progress: every other range commits while one range elects', async () => {
    const result = await search.quietly(() => search.scenarioIndependentLeaders({ seed: 21 }));
    assert.ok(result.ok, JSON.stringify(result.windows));
    const rangeWindows = result.windows.filter((w) => w.kind === 'range-leader-crash');
    assert.deepEqual(rangeWindows.map((w) => w.rangeId), ['r1', 'r2', 'r3'], 'each range lost its leader once');
    for (const w of rangeWindows) {
        assert.notEqual(w.newLeaderNode, w.crashedNode);
        for (const [rangeId, count] of Object.entries(w.committedByOtherRanges)) assert.ok(count >= 1, `${rangeId} during ${w.rangeId}'s election`);
    }
});

test('every scenario verdict is the conjunction of the common checks and its own conditions', async () => {
    // Guards a real bug found while recording the gate: spreading the common
    // verdict after `ok` overwrote each scenario's own conditions.
    const common = (r) => r.linearizability.ok && r.exactlyOnce.ok && r.ranges.ok && r.converged;
    const s1 = await search.quietly(() => search.scenarioIndependentLeaders({ seed: 1 }));
    assert.equal(s1.ok, common(s1) && s1.independent);
    const s2 = await search.quietly(() => search.scenarioDurability({ seed: 2 }));
    assert.equal(s2.ok, common(s2) && s2.survived && s2.stateSurvived);
    const s3 = await search.quietly(() => search.scenarioFencing({ seed: 3 }));
    assert.equal(s3.ok, common(s3) && s3.allRefused && s3.rejectedOnEveryReplica && s3.stateUnchanged);
    assert.equal(s3.rejectedOnEveryReplica, true, 'every replica applied every raw probe as a rejection');
    const s4 = await search.quietly(() => search.scenarioRetryAfterUnknown({ seed: 4 }));
    assert.equal(s4.ok, common(s4) && s4.retried === s4.writes && s4.answeredByDedup > 0);
    for (const s of [s1, s2, s3, s4]) assert.ok(s.ok, s.scenario);
});

test('a campaign run is a pure function of its seed', async () => {
    const a = await search.quietly(() => search.runCampaignSeed({ seed: 5, durationMs: 2500 }));
    const b = await search.quietly(() => search.runCampaignSeed({ seed: 5, durationMs: 2500 }));
    assert.equal(a.fingerprint, b.fingerprint);
    assert.ok(a.ok);
});

/** Runs `task` with `object[name]` replaced, then restores it. */
async function withMutant(object, name, replacement, task) {
    const original = object[name];
    object[name] = replacement;
    try { return await task(); } finally { object[name] = original; }
}

test('mutant: without deduplication a retried write applies twice, and only the ledger sees it', async () => {
    const result = await withMutant(RaftNode.prototype, '_findDuplicate', () => -1,
        () => search.quietly(() => search.scenarioRetryAfterUnknown({ seed: 4 })));
    assert.equal(result.ok, false);
    assert.ok(result.exactlyOnce.counts.appliedMoreThanOnce > 0, 'the exactly-once gate caught it');
    assert.equal(result.linearizability.ok, true, 'the register checker accepts a value written twice (§5.2)');
});

test('mutant: without the apply-time fence a mis-addressed write mutates state', async () => {
    const unfenced = function apply(entry) {
        const command = entry && entry.data;
        if (!command || INTERNAL_OPS.has(command.op)) return StateMachine.prototype.apply.call(this, entry);
        const result = StateMachine.prototype.apply.call(this, entry);
        this.ledger.push({
            index: entry.index, logicalRequestId: `${command.clientId}#${command.seqNo}`, clientId: command.clientId,
            seqNo: command.seqNo, key: command.key, op: command.op, rangeId: this.descriptor.rangeId, epoch: this.descriptor.epoch,
            addressedRangeId: command.rangeId, addressedEpoch: command.expectedRangeEpoch, outcome: 'applied',
        });
        return result;
    };
    const result = await withMutant(RangeStateMachine.prototype, 'apply', unfenced,
        () => search.quietly(() => search.scenarioFencing({ seed: 3 })));
    assert.equal(result.ok, false);
    assert.ok(result.exactlyOnce.counts.staleEpochWritesAccepted > 0);
    assert.equal(result.stateUnchanged, false);
});

test('mutant: a log that never reaches stable storage loses acknowledged writes across restart', async () => {
    const result = await withMutant(MemoryLogStore.prototype, 'append', function append(entries) { this.appendBuffered(entries); },
        () => search.quietly(() => search.scenarioDurability({ seed: 2 })));
    assert.equal(result.ok, false);
    assert.equal(result.survived, false);
});
