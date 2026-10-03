const assert = require('node:assert/strict');
const test = require('node:test');

const { RaftNode, STATES } = require('./raft');
const { MemoryStableStore, MemoryLogStore } = require('../sim/cluster');
const { ManualNetwork, turn } = require('../sim/manual-network');

const silent = () => {
    const log = console.log;
    console.log = () => {};
    return () => { console.log = log; };
};
const MEMBERS = ['http://l', 'http://a', 'http://b'];

function makeNode(url, net, extra = {}) {
    const node = new RaftNode({
        replicaId: url.slice(7),
        nodeUrl: url,
        members: MEMBERS,
        stableStore: new MemoryStableStore(),
        logStore: new MemoryLogStore(),
        storagePath: false,
        autoStart: false,
        transport: net.transport(),
        commitTimeoutMs: 60000,
        pipeline: { maxInflight: 4 },
        ...extra,
    });
    net.register(url, node);
    return node;
}

/** Leader of `term` with the two followers; heartbeats off, driven by hand. */
async function cluster(term = 1, extra = {}) {
    const net = new ManualNetwork();
    const leader = makeNode('http://l', net, extra);
    const a = makeNode('http://a', net, extra);
    const b = makeNode('http://b', net, extra);
    leader.currentTerm = term - 1;
    leader.state = STATES.CANDIDATE;
    leader.currentTerm = term;
    leader._becomeLeader();
    leader._stopHeartbeat();
    return { net, leader, a, b };
}

const deliverAll = (net, target) => net.deliverAll(target);

test('replicate mode keeps up to maxInflight batches outstanding and advances nextIndex optimistically', async () => {
    const restore = silent();
    try {
        const { net, leader } = await cluster();
        // Probe: exactly one request per follower until it matches.
        assert.equal(net.to('http://a').length, 1);
        await deliverAll(net, 'http://a');
        assert.equal(leader._progress['http://a'].mode, 'replicate');
        for (let i = 0; i < 6; i += 1) {
            void leader.clientAppend({ op: 'set', key: `k${i}`, value: i });
        }
        const outstanding = net.to('http://a');
        assert.equal(outstanding.length, 4, 'window of 4');
        assert.deepEqual(outstanding.map((m) => m.body.prevLogIndex), [0, 1, 2, 3]);
        assert.equal(leader.nextIndex['http://a'], 5, 'optimistic');
        assert.equal(leader.matchIndex['http://a'], 0, 'but nothing is counted until acknowledged');
        leader.stop();
    } finally { restore(); }
});

test('reordered acknowledgements never move matchIndex backwards and commit correctly', async () => {
    const restore = silent();
    try {
        const { net, leader } = await cluster();
        await deliverAll(net, 'http://a');
        await deliverAll(net, 'http://b');
        const writes = [0, 1, 2].map((i) => leader.clientAppend({ op: 'set', key: `k${i}`, value: i }));
        const toA = net.to('http://a');
        assert.equal(toA.length, 3);
        // Deliver to the follower in order, but return the replies newest first.
        const handled = [];
        for (const message of toA) {
            handled.push({ message, data: await net.nodes.get('http://a').handleAppendEntries(message.body) });
        }
        net.pending = net.pending.filter((m) => m.target !== 'http://a');
        for (const { message, data } of handled.reverse()) {
            message.resolve({ data });
            await turn();
            assert.equal(leader.matchIndex['http://a'], 3, 'the newest reply set it; older ones cannot lower it');
        }
        assert.equal(leader.commitIndex, 3);
        assert.deepEqual((await Promise.all(writes)).map((w) => w.committed), [true, true, true]);
        leader.stop();
    } finally { restore(); }
});

test('a request that overtakes its predecessor is rejected, probed, and repaired', async () => {
    const restore = silent();
    try {
        const { net, leader, a } = await cluster();
        await deliverAll(net, 'http://a');
        for (let i = 0; i < 3; i += 1) void leader.clientAppend({ op: 'set', key: `k${i}`, value: i });
        const [first, second, third] = net.to('http://a');
        // The third arrives first: its prevLogIndex is beyond a's log.
        const rejected = await net.deliver(third);
        assert.equal(rejected.success, false);
        assert.equal(leader._progress['http://a'].mode, 'probe');
        await net.deliver(first);
        await net.deliver(second);
        await deliverAll(net, 'http://a'); // the probe(s) sent after the rejection
        assert.equal(a.log.length, 4, 'every entry arrives exactly once');
        assert.deepEqual(a.log.map((e) => e.index), [0, 1, 2, 3]);
        assert.equal(leader.matchIndex['http://a'], 3);
        assert.equal(leader._progress['http://a'].mode, 'replicate');
        leader.stop();
    } finally { restore(); }
});

test('a stale rejection for a point the follower has since matched is ignored', async () => {
    const restore = silent();
    try {
        const { leader } = await cluster();
        leader.matchIndex['http://a'] = 5;
        leader.nextIndex['http://a'] = 9;
        leader._progressFor('http://a').mode = 'replicate';
        leader._onPipelineReject('http://a', { prevLogIndex: 4 }, { success: false, conflictIndex: 2 });
        assert.equal(leader.nextIndex['http://a'], 9);
        assert.equal(leader._progress['http://a'].mode, 'replicate');
        // A real one backs off, but never below matchIndex + 1.
        leader._onPipelineReject('http://a', { prevLogIndex: 8 }, { success: false, conflictIndex: 2 });
        assert.equal(leader.nextIndex['http://a'], 6);
        assert.equal(leader._progress['http://a'].mode, 'probe');
        leader.stop();
    } finally { restore(); }
});

test('conflicting follower logs are found and repaired through pipelined probing', async () => {
    const restore = silent();
    try {
        const { net, leader, a } = await cluster(3);
        // a holds a divergent suffix from an old term.
        a.currentTerm = 2;
        a.log = [
            { term: 1, index: 0, data: { op: 'set', key: 'x', value: 1 } },
            { term: 2, index: 1, data: { op: 'set', key: 'x', value: 'stale' } },
            { term: 2, index: 2, data: { op: 'set', key: 'x', value: 'stale2' } },
        ];
        leader.log = [
            { term: 1, index: 0, data: { op: 'set', key: 'x', value: 1 } },
            { term: 3, index: 1, data: { op: 'noop' } },
        ];
        leader.nextIndex['http://a'] = 2;
        leader.matchIndex['http://a'] = -1;
        leader._progress = {};
        net.pending = [];
        void leader.clientAppend({ op: 'set', key: 'x', value: 'fresh' });
        for (let round = 0; round < 10 && net.to('http://a').length; round += 1) await deliverAll(net, 'http://a');
        assert.deepEqual(a.log.map((e) => e.term), [1, 3, 3]);
        assert.equal(a.log[2].data.value, 'fresh');
        assert.equal(leader.matchIndex['http://a'], 2);
        leader.stop();
    } finally { restore(); }
});

test('a leadership change fences replies to requests sent under the old leadership', async () => {
    const restore = silent();
    try {
        const { net, leader } = await cluster(1);
        await deliverAll(net, 'http://a');
        void leader.clientAppend({ op: 'set', key: 'k', value: 1 });
        const old = net.to('http://a')[0];
        const oldReply = await net.nodes.get('http://a').handleAppendEntries(old.body);
        net.pending = [];
        // Deposed, then elected again in a later term with matchIndex reset.
        leader._becomeFollower(2);
        leader.state = STATES.CANDIDATE;
        leader.currentTerm = 3;
        leader._becomeLeader();
        leader._stopHeartbeat();
        assert.equal(leader.matchIndex['http://a'], -1);
        old.resolve({ data: oldReply });
        await turn();
        assert.equal(leader.matchIndex['http://a'], -1, 'the term-1 reply must not count in term 3');
        leader.stop();
    } finally { restore(); }
});

test('a retransmitted batch is idempotent at the follower', async () => {
    const restore = silent();
    try {
        const { net, leader, a } = await cluster();
        await deliverAll(net, 'http://a');
        void leader.clientAppend({ op: 'set', key: 'k', value: 1 });
        const message = net.to('http://a')[0];
        const store = a._logStore;
        const before = store.appends;
        const first = await a.handleAppendEntries(message.body);
        const again = await a.handleAppendEntries(message.body);
        assert.deepEqual(first, again);
        assert.equal(a.log.length, 2);
        assert.equal(store.appends - before, 1, 'the duplicate did not write anything');
        leader.stop();
    } finally { restore(); }
});

test('Figure 8 still holds: pipelined acks of an older-term entry do not commit it alone', async () => {
    const restore = silent();
    try {
        const { net, leader } = await cluster(4);
        // An entry from term 2 sits uncommitted in the new leader's log.
        leader.log.splice(0, leader.log.length, { term: 2, index: 0, data: { op: 'set', key: 'x', value: 'old' } });
        leader.commitIndex = -1;
        for (const url of ['http://a', 'http://b']) {
            leader.nextIndex[url] = 0;
            leader.matchIndex[url] = -1;
        }
        leader._progress = {};
        net.pending = [];
        leader._replicateAll();
        await deliverAll(net, 'http://a');
        await deliverAll(net, 'http://b');
        assert.equal(leader.matchIndex['http://a'], 0, 'a majority holds the term-2 entry');
        assert.equal(leader.commitIndex, -1, 'but it cannot be committed by counting replicas');
        const write = leader.clientAppend({ op: 'set', key: 'x', value: 'new' });
        await deliverAll(net, 'http://a');
        assert.equal(leader.commitIndex, 1, 'a current-term entry commits, and the old one with it');
        assert.equal((await write).committed, true);
        leader.stop();
    } finally { restore(); }
});

test('an RPC error drops the follower to probing from matchIndex + 1 without spinning', async () => {
    const restore = silent();
    try {
        const { net, leader } = await cluster();
        await deliverAll(net, 'http://a');
        // Committing the no-op schedules the one-shot commit broadcast (a real
        // 0 ms timer). Let it fire and drain first, or it can land after the
        // error below and legitimately send one probe of its own.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await deliverAll(net, 'http://a');
        for (let i = 0; i < 3; i += 1) void leader.clientAppend({ op: 'set', key: `k${i}`, value: i });
        const [first] = net.to('http://a');
        net.fail(first);
        await turn();
        assert.equal(leader._progress['http://a'].mode, 'probe');
        assert.equal(leader.nextIndex['http://a'], 1);
        const sentAfterError = net.to('http://a').length;
        assert.equal(sentAfterError, 2, 'no new request until the heartbeat retries');
        leader.stop();
    } finally { restore(); }
});

test('lease freshness uses the send time of acknowledged requests', async () => {
    const restore = silent();
    try {
        let now = 1000;
        const clock = {
            now: () => now,
            setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
        };
        const { net, leader } = await cluster(1, { clock });
        const probe = net.to('http://a')[0];
        now = 1400; // the reply takes 400 ms to come back
        await net.deliver(probe);
        assert.equal(leader.lastQuorumContactAt, 1000, 'the quorum contact is when the request left');
        leader.stop();
    } finally { restore(); }
});
