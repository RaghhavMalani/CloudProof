const assert = require('node:assert/strict');
const test = require('node:test');

const { LinearizabilityChecker, registerModel } = require('./linearizability');

// A checker that only ever says "linearizable" is useless, so roughly half of
// these are histories it must *reject*. Getting a checker to accept valid
// histories is easy; getting it to reject subtly invalid ones is the work.

const checker = new LinearizabilityChecker();
const inv = (p, op, at) => ({ process: p, type: 'invoke', op, at });
const ok = (p, result, at) => ({ process: p, type: 'ok', op: { result }, at });
const info = (p, at) => ({ process: p, type: 'info', op: {}, at });

test('accepts a trivially sequential history', () => {
    const history = [
        inv(1, { kind: 'write', key: 'x', value: 'a' }, 0), ok(1, true, 1),
        inv(1, { kind: 'read', key: 'x' }, 2), ok(1, 'a', 3),
    ];
    assert.equal(checker.check(history).linearizable, true);
});

test('rejects a read that returns a value never written', () => {
    const history = [
        inv(1, { kind: 'write', key: 'x', value: 'a' }, 0), ok(1, true, 1),
        inv(1, { kind: 'read', key: 'x' }, 2), ok(1, 'ghost', 3),
    ];
    const result = checker.check(history);
    assert.equal(result.linearizable, false);
    assert.match(result.reason, /no ordering/);
});

test('rejects a stale read — the real-time constraint', () => {
    // The write COMPLETED at t=1. The read STARTED at t=2. There is no instant
    // in the read's window at which x was still empty, so returning null is a
    // linearizability violation even though it is sequentially consistent.
    // A checker that misses this has quietly become a much weaker one.
    const history = [
        inv(1, { kind: 'write', key: 'x', value: 'a' }, 0), ok(1, true, 1),
        inv(2, { kind: 'read', key: 'x' }, 2), ok(2, null, 3),
    ];
    assert.equal(checker.check(history).linearizable, false);
});

test('accepts a stale read when the operations genuinely overlap', () => {
    // Same values, but now the read begins before the write returns. The write
    // may be linearized after the read, so null is a legitimate answer.
    const history = [
        inv(1, { kind: 'write', key: 'x', value: 'a' }, 0),
        inv(2, { kind: 'read', key: 'x' }, 1), ok(2, null, 2),
        ok(1, true, 3),
    ];
    assert.equal(checker.check(history).linearizable, true);
});

test('accepts concurrent writes resolved in either order', () => {
    const history = [
        inv(1, { kind: 'write', key: 'x', value: 'a' }, 0),
        inv(2, { kind: 'write', key: 'x', value: 'b' }, 1),
        ok(1, true, 2), ok(2, true, 3),
        inv(3, { kind: 'read', key: 'x' }, 4), ok(3, 'b', 5),
    ];
    assert.equal(checker.check(history).linearizable, true);
});

test('rejects two reads that disagree with no write between them', () => {
    // This is the shape a split-brain produces: two clients read different
    // values from a key nobody wrote in between.
    const history = [
        inv(1, { kind: 'write', key: 'x', value: 'a' }, 0), ok(1, true, 1),
        inv(2, { kind: 'read', key: 'x' }, 2), ok(2, 'a', 3),
        inv(3, { kind: 'read', key: 'x' }, 4), ok(3, 'b', 5),
    ];
    assert.equal(checker.check(history).linearizable, false);
});

test('a timed-out write that silently took effect is still linearizable', () => {
    // Client 1 never learns the outcome. Client 2 then observes the value, so
    // the only consistent explanation is that the write DID happen. A checker
    // that dropped unresolved operations would wrongly flag this.
    const history = [
        inv(1, { kind: 'write', key: 'x', value: 'a' }, 0), info(1, 1),
        inv(2, { kind: 'read', key: 'x' }, 2), ok(2, 'a', 3),
    ];
    assert.equal(checker.check(history).linearizable, true);
});

test('a timed-out write that did not take effect is also linearizable', () => {
    // The mirror case. Both explanations must be available, which is why
    // pending operations are explored in both branches.
    const history = [
        inv(1, { kind: 'write', key: 'x', value: 'a' }, 0), info(1, 1),
        inv(2, { kind: 'read', key: 'x' }, 2), ok(2, null, 3),
    ];
    assert.equal(checker.check(history).linearizable, true);
});

test('compare-and-swap: only one of two concurrent claims may win', () => {
    const legal = [
        inv(1, { kind: 'cas', key: 'k', expected: null, value: 'p1' }, 0),
        inv(2, { kind: 'cas', key: 'k', expected: null, value: 'p2' }, 1),
        ok(1, true, 2), ok(2, false, 3),
        inv(3, { kind: 'read', key: 'k' }, 4), ok(3, 'p1', 5),
    ];
    assert.equal(checker.check(legal).linearizable, true);

    // Both winning is exactly the failure a lock built on CAS must never
    // exhibit — two holders of the same lease.
    const illegal = [
        inv(1, { kind: 'cas', key: 'k', expected: null, value: 'p1' }, 0),
        inv(2, { kind: 'cas', key: 'k', expected: null, value: 'p2' }, 1),
        ok(1, true, 2), ok(2, true, 3),
    ];
    assert.equal(checker.check(illegal).linearizable, false);
});

test('rejects a lost update across non-overlapping windows', () => {
    const history = [
        inv(1, { kind: 'write', key: 'x', value: 'v1' }, 0), ok(1, true, 1),
        inv(2, { kind: 'write', key: 'x', value: 'v2' }, 2), ok(2, true, 3),
        inv(3, { kind: 'read', key: 'x' }, 4), ok(3, 'v1', 5),
    ];
    assert.equal(checker.check(history).linearizable, false);
});

test('handles a wide concurrent history without exploding', () => {
    // Eight processes writing and reading the same key simultaneously. The
    // point is that memoisation keeps the search from becoming factorial.
    const history = [];
    for (let p = 1; p <= 8; p += 1) history.push(inv(p, { kind: 'write', key: 'x', value: `v${p}` }, 0));
    for (let p = 1; p <= 8; p += 1) history.push(ok(p, true, 1));
    history.push(inv(9, { kind: 'read', key: 'x' }, 2), ok(9, 'v5', 3));

    const result = checker.check(history);
    assert.equal(result.linearizable, true);
    console.log(`      8 concurrent writers resolved in ${result.steps} steps`);
    assert.ok(result.steps < 50000, `search took ${result.steps} steps — memoisation is not working`);
});

test('the witness it returns is a genuine sequential explanation', () => {
    const history = [
        inv(1, { kind: 'write', key: 'x', value: 'a' }, 0),
        inv(2, { kind: 'write', key: 'x', value: 'b' }, 1),
        ok(1, true, 2), ok(2, true, 3),
        inv(3, { kind: 'read', key: 'x' }, 4), ok(3, 'a', 5),
    ];
    const result = checker.check(history);
    assert.equal(result.linearizable, true);

    // Replay the witness through the model and confirm it actually produces
    // the observed results. A checker that returns an unverifiable witness is
    // asking to be trusted, which rather defeats the purpose.
    let state = registerModel.init();
    for (const op of result.witness) {
        const outcome = registerModel.apply(state, op);
        assert.equal(outcome.ok, true, `witness step ${JSON.stringify(op)} was not applicable`);
        state = outcome.state;
    }
    assert.equal(state.x, 'a', 'the witness must end in the state the final read observed');
});
