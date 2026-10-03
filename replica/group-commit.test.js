const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { RaftNode, STATES } = require('./raft');
const { LogStore } = require('./log-store');
const { MemoryStableStore, MemoryLogStore } = require('../sim/cluster');

const GC = { maxEntries: 1024, maxDelayMs: 60000, metaIntervalMs: 60000 }; // flush only when told
const tick = () => new Promise((resolve) => setImmediate(resolve));
const silent = () => {
    const log = console.log;
    console.log = () => {};
    return () => { console.log = log; };
};

function follower({ stores = { stable: new MemoryStableStore(), log: new MemoryLogStore() }, groupCommit = GC } = {}) {
    const node = new RaftNode({
        replicaId: 'f1',
        nodeUrl: 'http://f1',
        members: ['http://l', 'http://f1', 'http://f2'],
        stableStore: stores.stable,
        logStore: stores.log,
        storagePath: false,
        autoStart: false,
        groupCommit,
    });
    return { node, stores };
}

function entry(term, index, value = index) {
    return { term, index, ts: 1, data: { op: 'set', key: `k${index}`, value } };
}

async function isSettled(promise) {
    let settled = false;
    promise.then(() => { settled = true; });
    await tick();
    return settled;
}

test('a follower does not acknowledge an append until it is durable', async () => {
    const restore = silent();
    try {
        const { node, stores } = follower();
        const response = node.handleAppendEntries({
            term: 1, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: -1, prevLogTerm: 0,
            entries: [entry(1, 0), entry(1, 1)], leaderCommit: -1,
        });
        assert.equal(typeof response.then, 'function', 'the ack is deferred');
        assert.equal(await isSettled(response), false, 'no ack before the flush');
        assert.equal(stores.log.entries.length, 0, 'nothing is on "disk" yet');
        assert.equal(node.log.length, 2, 'but the entries are in the log');

        node.flushDurable();
        const ack = await response;
        assert.deepEqual({ success: ack.success, matchIndex: ack.matchIndex, term: ack.term }, { success: true, matchIndex: 1, term: 1 });
        assert.equal(stores.log.entries.length, 2);
        assert.equal(stores.log.flushes, 1);
        node.stop();
    } finally { restore(); }
});

test('crash before the grouped flush: unacknowledged entries vanish, the ack is never sent', async () => {
    const restore = silent();
    try {
        const { node, stores } = follower();
        const response = node.handleAppendEntries({
            term: 1, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: -1, prevLogTerm: 0,
            entries: [entry(1, 0), entry(1, 1), entry(1, 2)], leaderCommit: -1,
        });
        // Crash: stop() cancels the flush, the volatile buffer is lost.
        node.stop();
        stores.log.dropPending();
        assert.equal(await isSettled(response), false, 'a crashed node never acknowledges');

        const { node: restarted } = follower({ stores });
        assert.equal(restarted.log.length, 0, 'nothing that was never acknowledged survives');
        restarted.stop();
    } finally { restore(); }
});

test('crash after the flush but before the response: the entries survive the restart', async () => {
    const restore = silent();
    try {
        const { node, stores } = follower();
        const response = node.handleAppendEntries({
            term: 1, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: -1, prevLogTerm: 0,
            entries: [entry(1, 0), entry(1, 1)], leaderCommit: -1,
        });
        node.flushDurable();
        // The response is ready but the process dies before it leaves.
        node.stop();
        stores.log.dropPending();
        assert.equal((await response).success, true);

        const { node: restarted } = follower({ stores });
        assert.deepEqual(restarted.log.map((e) => e.index), [0, 1]);
        restarted.stop();
    } finally { restore(); }
});

test('an ack prepared in one term is revoked if the term changes before it is durable', async () => {
    const restore = silent();
    try {
        const { node } = follower();
        const stale = node.handleAppendEntries({
            term: 2, leaderId: 'old', leaderUrl: 'http://old', prevLogIndex: -1, prevLogTerm: 0,
            entries: [entry(2, 0), entry(2, 1)], leaderCommit: -1,
        });
        // A leader of term 3 overwrites index 1 before the flush.
        const fresh = node.handleAppendEntries({
            term: 3, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: 0, prevLogTerm: 2,
            entries: [entry(3, 1, 'new')], leaderCommit: -1,
        });
        const revoked = await stale; // truncation made everything retained durable
        assert.equal(revoked.success, false, 'the old leader must not count index 1');
        assert.equal(revoked.term, 3, 'and learns about the newer term');
        node.flushDurable();
        const ack = await fresh;
        assert.equal(ack.success, true);
        assert.equal(node.log[1].data.value, 'new');
        node.stop();
    } finally { restore(); }
});

test('a heartbeat that names a buffered index is also held until durable', async () => {
    const restore = silent();
    try {
        const { node } = follower();
        void node.handleAppendEntries({
            term: 1, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: -1, prevLogTerm: 0,
            entries: [entry(1, 0), entry(1, 1)], leaderCommit: -1,
        });
        // A pipelining leader's heartbeat can arrive before the flush.
        const heartbeat = node.handleAppendEntries({
            term: 1, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: 1, prevLogTerm: 1,
            entries: [], leaderCommit: -1,
        });
        assert.equal(typeof heartbeat.then, 'function');
        assert.equal(await isSettled(heartbeat), false);
        node.flushDurable();
        assert.equal((await heartbeat).matchIndex, 1);
        // An empty log's heartbeat needs nothing durable and is answered at once.
        const { node: empty } = follower();
        const immediate = empty.handleAppendEntries({
            term: 1, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: -1, prevLogTerm: 0, entries: [], leaderCommit: -1,
        });
        assert.equal(immediate.success, true);
        node.stop();
        empty.stop();
    } finally { restore(); }
});

test('truncation with a pending buffer writes the retained prefix durably', async () => {
    const restore = silent();
    try {
        const { node, stores } = follower();
        void node.handleAppendEntries({
            term: 1, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: -1, prevLogTerm: 0,
            entries: [entry(1, 0), entry(1, 1), entry(1, 2)], leaderCommit: -1,
        });
        void node.handleAppendEntries({
            term: 2, leaderId: 'l2', leaderUrl: 'http://l2', prevLogIndex: 1, prevLogTerm: 1,
            entries: [entry(2, 2, 'x')], leaderCommit: -1,
        });
        // Crash without a flush: the rewrite made 0..1 durable; the new index 2 was buffered.
        node.stop();
        stores.log.dropPending();
        const { node: restarted } = follower({ stores });
        assert.deepEqual(restarted.log.map((e) => `${e.index}@${e.term}`), ['0@1', '1@1']);
        restarted.stop();
    } finally { restore(); }
});

test('the leader counts its own copy only once it is durable', async () => {
    const restore = silent();
    try {
        const posted = [];
        const node = new RaftNode({
            replicaId: 'l',
            nodeUrl: 'http://l',
            members: ['http://l', 'http://f1', 'http://f2'],
            stableStore: new MemoryStableStore(),
            logStore: new MemoryLogStore(),
            storagePath: false,
            autoStart: false,
            groupCommit: GC,
            commitTimeoutMs: 5000,
            transport: {
                post: (url, body) => {
                    posted.push(url);
                    // f1 acknowledges everything; f2 is unreachable.
                    if (url.startsWith('http://f2')) return new Promise(() => {});
                    const matchIndex = body.prevLogIndex + body.entries.length;
                    return Promise.resolve({ data: { term: body.term, success: true, matchIndex } });
                },
            },
        });
        node.state = STATES.CANDIDATE;
        node.currentTerm = 1;
        node._becomeLeader();
        node._stopHeartbeat();
        await tick(); // f1 acknowledges the no-op
        const write = node.clientAppend({ op: 'set', key: 'a', value: 1 });
        await tick();
        await tick();
        assert.ok(node.matchIndex['http://f1'] >= 1, 'f1 has the write');
        assert.equal(node.commitIndex, -1, 'leader + f1 is a majority only if the leader copy is durable');
        node.flushDurable();
        const outcome = await write;
        assert.equal(outcome.committed, true);
        assert.equal(node.commitIndex, 1);
        node.stop();
    } finally { restore(); }
});

test('appends in one event-loop turn share one fsync (real LogStore)', async () => {
    const restore = silent();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudproof-gc-'));
    try {
        const log = new LogStore(path.join(directory, 'r.log'));
        const node = new RaftNode({
            replicaId: 'solo',
            nodeUrl: 'http://solo',
            members: ['http://solo'],
            stableStore: new MemoryStableStore(),
            logStore: log,
            storagePath: false,
            autoStart: false,
            groupCommit: { maxEntries: 1024, maxDelayMs: 0, metaIntervalMs: 60000 },
        });
        node.state = STATES.CANDIDATE;
        node.currentTerm = 1;
        node._becomeLeader();
        node._stopHeartbeat();
        await new Promise((resolve) => setTimeout(resolve, 5)); // let the no-op flush
        const before = log.fsyncCount;
        const writes = Array.from({ length: 50 }, (_, i) => node.clientAppend({ op: 'set', key: `k${i}`, value: i }));
        const outcomes = await Promise.all(writes);
        assert.ok(outcomes.every((o) => o.committed));
        assert.equal(log.fsyncCount - before, 1, '50 writes, one fsync');
        node.stop();

        const reloaded = new LogStore(path.join(directory, 'r.log')).load();
        assert.equal(reloaded.length, 51, 'no-op + 50 writes, all durable, in order');
        assert.deepEqual(reloaded.map((e) => e.index), reloaded.map((_, i) => i));
    } finally {
        restore();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a lagging persisted commit index is safe: restart replays less and loses nothing', async () => {
    const restore = silent();
    try {
        const { node, stores } = follower({ groupCommit: { maxEntries: 1024, maxDelayMs: 0, metaIntervalMs: 60000 } });
        const response = node.handleAppendEntries({
            term: 1, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: -1, prevLogTerm: 0,
            entries: [entry(1, 0), entry(1, 1), entry(1, 2)], leaderCommit: 2,
        });
        node.flushDurable(); // entries durable; also persists the dirty commit index
        await response;
        assert.equal(node.commitIndex, 2);
        const savesAfterFlush = stores.stable.writes;
        void node.handleAppendEntries({
            term: 1, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: 2, prevLogTerm: 1,
            entries: [entry(1, 3)], leaderCommit: 3,
        });
        node._flushLog(); // the log flush alone does not rewrite metadata
        assert.equal(node.commitIndex, 3);
        assert.equal(stores.stable.writes, savesAfterFlush, 'commit advance did not cost a metadata write');
        node.stop(); // crash: the lazy commit index (3) was never written

        const { node: restarted } = follower({ stores });
        assert.equal(restarted.log.length, 4, 'every durable entry is still there');
        assert.equal(restarted.commitIndex, 2, 'the persisted commit index lags');
        assert.equal(restarted.stateMachine.get('k2').value, 2, 'the committed prefix it knows about is replayed');
        // The leader's next heartbeat restores the true commit point.
        restarted.handleAppendEntries({
            term: 1, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: 3, prevLogTerm: 1, entries: [], leaderCommit: 3,
        });
        assert.equal(restarted.commitIndex, 3);
        assert.equal(restarted.stateMachine.get('k3').value, 3);
        restarted.stop();
    } finally { restore(); }
});

test('group commit off keeps the original synchronous contract', () => {
    const restore = silent();
    try {
        const stores = { stable: new MemoryStableStore(), log: new MemoryLogStore() };
        const { node } = follower({ stores, groupCommit: null });
        const response = node.handleAppendEntries({
            term: 1, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: -1, prevLogTerm: 0,
            entries: [entry(1, 0)], leaderCommit: 0,
        });
        assert.equal(response.success, true, 'answered synchronously');
        assert.equal(stores.log.entries.length, 1, 'durable before answering');
        // One write adopting term 1, one for the commit advance: synchronous, as before.
        assert.equal(stores.stable.writes, 2, 'commit index persisted on the advance');
        node.stop();
    } finally { restore(); }
});
