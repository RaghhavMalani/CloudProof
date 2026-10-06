const assert = require('node:assert/strict');
const test = require('node:test');

const { RaftNode, STATES } = require('./raft');
const { MemoryStableStore, MemoryLogStore } = require('../sim/cluster');
const { ManualNetwork, turn } = require('../sim/manual-network');
const { entryLength } = require('./entry-codec');

const silent = () => {
    const log = console.log;
    console.log = () => {};
    return () => { console.log = log; };
};
const MEMBERS = ['http://l', 'http://a', 'http://b'];

function node(url, net, options) {
    const n = new RaftNode({
        replicaId: url.slice(7), nodeUrl: url, members: MEMBERS,
        stableStore: new MemoryStableStore(), logStore: new MemoryLogStore(), storagePath: false,
        autoStart: false, transport: net.transport(), commitTimeoutMs: 60000, ...options,
    });
    net.register(url, n);
    return n;
}

function cluster(options) {
    const net = new ManualNetwork();
    const leader = node('http://l', net, options);
    const a = node('http://a', net, options);
    const b = node('http://b', net, options);
    leader.state = STATES.CANDIDATE;
    leader.currentTerm = 1;
    leader._becomeLeader();
    leader._stopHeartbeat();
    return { net, leader, a, b };
}

const appendEntriesTo = (net, target) => net.sent.filter((m) => m.target === target && m.route === '/append-entries');

test('a single write travels alone', async () => {
    const restore = silent();
    try {
        const { net, leader } = cluster({ pipeline: { maxInflight: 4 }, replicationBatch: { maxEntries: 4, maxBytes: 1 << 20 } });
        await net.deliverAll('http://a');
        const before = appendEntriesTo(net, 'http://a').length;
        void leader.clientAppend({ op: 'set', key: 'k', value: 1 });
        await turn();
        const sent = appendEntriesTo(net, 'http://a').slice(before);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].body.entries.length, 1);
        leader.stop();
    } finally { restore(); }
});

test('writes in one turn share one coalesced round, split into full and partial batches', async () => {
    const restore = silent();
    try {
        const { net, leader, a } = cluster({ pipeline: { maxInflight: 8 }, replicationBatch: { maxEntries: 4, maxBytes: 1 << 20 } });
        await net.deliverAll('http://a');
        const before = appendEntriesTo(net, 'http://a').length;
        for (let i = 0; i < 10; i += 1) void leader.clientAppend({ op: 'set', key: `k${i}`, value: i });
        assert.equal(appendEntriesTo(net, 'http://a').length, before, 'nothing is sent per write');
        await turn(); // end of the turn: one round
        const sent = appendEntriesTo(net, 'http://a').slice(before);
        assert.deepEqual(sent.map((m) => m.body.entries.length), [4, 4, 2], '10 entries -> 4 + 4 + 2');
        assert.deepEqual(sent.map((m) => m.body.prevLogIndex), [0, 4, 8], 'contiguous');
        await net.deliverAll('http://a');
        assert.equal(a.log.length, 11);
        leader.stop();
    } finally { restore(); }
});

test('the byte cap bounds a batch, and an oversized entry still moves on its own', async () => {
    const restore = silent();
    try {
        const { net, leader } = cluster({ pipeline: { maxInflight: 8 }, replicationBatch: { maxEntries: 100, maxBytes: 700 } });
        await net.deliverAll('http://a');
        const before = appendEntriesTo(net, 'http://a').length;
        const value = 'v'.repeat(250);
        for (let i = 0; i < 5; i += 1) void leader.clientAppend({ op: 'set', key: `k${i}`, value });
        void leader.clientAppend({ op: 'set', key: 'huge', value: 'h'.repeat(2000) });
        await turn();
        const sent = appendEntriesTo(net, 'http://a').slice(before);
        for (const message of sent) {
            const bytes = message.body.entries.reduce((sum, e) => sum + entryLength(e), 0);
            assert.ok(message.body.entries.length === 1 || bytes <= 700, `batch of ${bytes} bytes`);
        }
        assert.equal(sent.reduce((n, m) => n + m.body.entries.length, 0), 6, 'every entry is sent once');
        assert.ok(sent.some((m) => m.body.entries.length === 1 && m.body.entries[0].data.key === 'huge'));
        leader.stop();
    } finally { restore(); }
});

test('a lagging follower is caught up in bounded batches', async () => {
    const restore = silent();
    try {
        const options = { pipeline: { maxInflight: 2 }, replicationBatch: { maxEntries: 5, maxBytes: 1 << 20 } };
        const { net, leader, b } = cluster(options);
        await net.deliverAll('http://a');
        // b hears nothing while 23 writes commit through a.
        const writes = [];
        for (let i = 0; i < 23; i += 1) writes.push(leader.clientAppend({ op: 'set', key: `k${i}`, value: i }));
        await turn();
        await net.deliverAll('http://a');
        assert.ok((await Promise.all(writes)).every((w) => w.committed));
        // Everything sent to b was lost; its RPCs time out.
        for (const message of net.to('http://b')) net.fail(message);
        await turn();
        const before = appendEntriesTo(net, 'http://b').length;
        leader._replicateAll();
        await net.deliverAll('http://b', { rounds: 100 });
        const sent = appendEntriesTo(net, 'http://b').slice(before);
        assert.equal(b.log.length, 24);
        assert.deepEqual(b.log.map((e) => e.index), b.log.map((_, i) => i));
        assert.ok(sent.every((m) => m.body.entries.length <= 5), 'no request exceeds the batch bound');
        assert.equal(leader.matchIndex['http://b'], 23);
        leader.stop();
    } finally { restore(); }
});

test('a log conflict is repaired with bounded batches', async () => {
    const restore = silent();
    try {
        const { net, leader, a } = cluster({ pipeline: { maxInflight: 4 }, replicationBatch: { maxEntries: 2, maxBytes: 1 << 20 } });
        net.pending = [];
        // a kept five uncommitted entries from a deposed term-1 leader; the
        // term-2 leader's log diverges from index 1 on.
        a.currentTerm = 1;
        a.log = [0, 1, 2, 3, 4, 5].map((i) => ({ term: 1, index: i, data: { op: 'set', key: 'x', value: `stale${i}` } }));
        leader.currentTerm = 2;
        leader.log.splice(0, leader.log.length,
            { term: 1, index: 0, data: { op: 'set', key: 'x', value: 'stale0' } },
            ...[1, 2, 3, 4, 5, 6, 7].map((i) => ({ term: 2, index: i, data: { op: 'set', key: 'x', value: `good${i}` } })));
        leader.nextIndex['http://a'] = 8;
        leader.matchIndex['http://a'] = -1;
        leader._progress = {};
        leader._replicateAll();
        await net.deliverAll('http://a', { rounds: 100 });
        assert.deepEqual(a.log.map((e) => e.data.value), ['stale0', 'good1', 'good2', 'good3', 'good4', 'good5', 'good6', 'good7']);
        assert.ok(appendEntriesTo(net, 'http://a').every((m) => m.body.entries.length <= 2));
        leader.stop();
    } finally { restore(); }
});

test('stop-and-wait replication also honours the batch bound', async () => {
    const restore = silent();
    try {
        const { net, leader, a } = cluster({ replicationBatch: { maxEntries: 3, maxBytes: 1 << 20, coalesce: false } });
        for (const message of [...net.pending]) net.fail(message);
        await turn();
        for (let i = 0; i < 7; i += 1) void leader.clientAppend({ op: 'set', key: `k${i}`, value: i });
        for (let round = 0; round < 10; round += 1) {
            leader._replicateAll();
            await net.deliverAll('http://a');
        }
        assert.equal(a.log.length, 8);
        assert.ok(appendEntriesTo(net, 'http://a').every((m) => m.body.entries.length <= 3));
        leader.stop();
    } finally { restore(); }
});
