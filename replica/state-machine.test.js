const assert = require('node:assert/strict');
const test = require('node:test');

const { StateMachine } = require('./state-machine');

let nextIndex = 0;
function entry(data, ts) {
    return { term: 1, index: nextIndex++, ts, data };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('cas with expectRev 0 claims a key exactly once', () => {
    const sm = new StateMachine();

    const first = sm.apply(entry({ op: 'cas', key: 'shard/0', expectRev: 0, value: 'pod-a' }, 1000));
    const second = sm.apply(entry({ op: 'cas', key: 'shard/0', expectRev: 0, value: 'pod-b' }, 1001));

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.error, 'revision mismatch');
    assert.equal(second.actual, 'pod-a', 'the loser is told who won');
    assert.equal(sm.get('shard/0').value, 'pod-a');

    // The loser can now swap using the revision it was just handed.
    const retry = sm.apply(entry({
        op: 'cas', key: 'shard/0', expectRev: second.actualRev, value: 'pod-b',
    }, 1002));
    assert.equal(retry.ok, true);
    assert.equal(sm.get('shard/0').value, 'pod-b');
});

test('cas with value null deletes conditionally', () => {
    const sm = new StateMachine();
    const set = sm.apply(entry({ op: 'set', key: 'model', value: 'v1' }, 2000));

    const wrongRev = sm.apply(entry({ op: 'cas', key: 'model', expectRev: set.rev + 99, value: null }, 2001));
    assert.equal(wrongRev.ok, false);
    assert.ok(sm.get('model'));

    const removed = sm.apply(entry({ op: 'cas', key: 'model', expectRev: set.rev, value: null }, 2002));
    assert.equal(removed.ok, true);
    assert.equal(removed.deleted, true);
    assert.equal(sm.get('model'), null);
});

test('a lease blocks another holder until it expires', () => {
    const sm = new StateMachine();

    const granted = sm.apply(entry({ op: 'lease-acquire', key: 'shard/3', holder: 'pod-a', ttlMs: 500 }, 5000));
    assert.equal(granted.ok, true);
    assert.equal(granted.expiresAt, 5500);

    const contested = sm.apply(entry({ op: 'lease-acquire', key: 'shard/3', holder: 'pod-b', ttlMs: 500 }, 5200));
    assert.equal(contested.ok, false);
    assert.equal(contested.error, 'held');
    assert.equal(contested.holder, 'pod-a');

    // A renewal pushes expiry out from the logical clock, not from wall time.
    const renewed = sm.apply(entry({ op: 'lease-renew', key: 'shard/3', holder: 'pod-a', ttlMs: 500 }, 5300));
    assert.equal(renewed.ok, true);
    assert.equal(renewed.expiresAt, 5800);

    // Still held at 5700.
    assert.equal(sm.apply(entry({ op: 'lease-acquire', key: 'shard/3', holder: 'pod-b', ttlMs: 500 }, 5700)).ok, false);

    // Past 5800 the lease is gone and pod-b takes over.
    const takeover = sm.apply(entry({ op: 'lease-acquire', key: 'shard/3', holder: 'pod-b', ttlMs: 500 }, 5900));
    assert.equal(takeover.ok, true);
    assert.equal(sm.get('shard/3').value, 'pod-b');
    assert.ok(
        sm.events.some((event) => event.type === 'lease-expired' && event.holder === 'pod-a'),
        'expiry is observable to watchers',
    );
});

test('a stale timestamp cannot rewind the logical clock', () => {
    const sm = new StateMachine();
    sm.apply(entry({ op: 'lease-acquire', key: 'shard/1', holder: 'pod-a', ttlMs: 100 }, 9000));

    // A deposed leader's entry arriving late must not move time backwards, or
    // an expired lease could appear live again.
    sm.apply(entry({ op: 'set', key: 'noise', value: 1 }, 3000));
    assert.equal(sm.clock, 9000);

    sm.apply(entry({ op: 'set', key: 'noise', value: 2 }, 9200));
    assert.equal(sm.leases.size, 0, 'the lease expired exactly once time passed 9100');
});

test('replicas that apply the same entries at different real times agree exactly', async () => {
    // This is the property that makes leases safe. The two machines below run
    // minutes apart in wall-clock terms — a follower catching up after a
    // partition — and must still land on identical state, including which
    // leases are live.
    const stream = [
        { op: 'lease-acquire', key: 'shard/0', holder: 'pod-a', ttlMs: 300 },
        { op: 'lease-acquire', key: 'shard/1', holder: 'pod-b', ttlMs: 5000 },
        { op: 'set', key: 'model/current', value: 'clip-v2' },
        { op: 'lease-renew', key: 'shard/0', holder: 'pod-a', ttlMs: 300 },
        { op: 'cas', key: 'model/current', expect: 'clip-v2', value: 'clip-v3' },
        { op: 'tick' },
        { op: 'tick' },
    ].map((data, offset) => ({ term: 1, index: offset, ts: 10000 + offset * 200, data }));

    const fast = new StateMachine();
    const slow = new StateMachine();

    for (const item of stream) fast.apply(item);
    for (const item of stream) {
        await sleep(5);
        slow.apply(item);
    }

    assert.deepEqual(slow.snapshot(), fast.snapshot());
    assert.equal(fast.get('model/current').value, 'clip-v3');
    assert.equal(fast.leaseInfo('shard/0'), null, 'pod-a stopped renewing and lost the shard');
    assert.equal(fast.leaseInfo('shard/1').holder, 'pod-b');
});

test('watchers resume from a revision without missing events', () => {
    const sm = new StateMachine();
    sm.apply(entry({ op: 'set', key: 'model/current', value: 'v1' }, 100));
    const checkpoint = sm.revision;

    sm.apply(entry({ op: 'set', key: 'other/thing', value: 'x' }, 101));
    sm.apply(entry({ op: 'set', key: 'model/current', value: 'v2' }, 102));

    const missed = sm.eventsSince(checkpoint, { prefix: 'model/' });
    assert.equal(missed.length, 1);
    assert.equal(missed[0].value, 'v2');
    assert.equal(sm.eventsSince(checkpoint).length, 2, 'an unfiltered watcher sees both');
});

test('lease renewal does not bump the revision', () => {
    const sm = new StateMachine();
    sm.apply(entry({ op: 'lease-acquire', key: 'shard/9', holder: 'pod-a', ttlMs: 1000 }, 500));
    const afterGrant = sm.revision;

    sm.apply(entry({ op: 'lease-renew', key: 'shard/9', holder: 'pod-a', ttlMs: 1000 }, 600));
    sm.apply(entry({ op: 'lease-renew', key: 'shard/9', holder: 'pod-a', ttlMs: 1000 }, 700));

    assert.equal(sm.revision, afterGrant, 'heartbeat renewals stay invisible to watchers');
});
