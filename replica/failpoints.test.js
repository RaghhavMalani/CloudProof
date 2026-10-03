const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { Failpoints, SITES } = require('./failpoints');
const { RaftNode, STATES } = require('./raft');
const { MemoryStableStore, MemoryLogStore } = require('../sim/cluster');
const { ManualNetwork, turn } = require('../sim/manual-network');

const MEMBERS = ['http://l', 'http://a', 'http://b'];
const quiet = async (fn) => {
    const log = console.log;
    console.log = () => {};
    try { return await fn(); } finally { console.log = log; }
};

function cluster(options) {
    const calls = [];
    const net = new ManualNetwork();
    const nodes = MEMBERS.map((url) => {
        const node = new RaftNode({
            replicaId: url.slice(7), nodeUrl: url, members: MEMBERS,
            stableStore: new MemoryStableStore(), logStore: new MemoryLogStore(), storagePath: false,
            autoStart: false, transport: net.transport(), commitTimeoutMs: 60000,
            failpoint: (name, context) => calls.push({ name, context }),
            ...options,
        });
        net.register(url, node);
        return node;
    });
    const [leader] = nodes;
    leader.state = STATES.CANDIDATE;
    leader.currentTerm = 1;
    leader._becomeLeader();
    leader._stopHeartbeat();
    return { net, nodes, leader, calls };
}

const named = (calls, name) => calls.filter((c) => c.name === name);

test('an armed failpoint fires once, after `skip` hits, and records the engine state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
    const fired = [];
    const fp = new Failpoints({ markerFile: path.join(dir, 'marker.json'), fire: (f) => fired.push(f) });
    assert.throws(() => fp.arm('no.such.site'), /unknown failpoint/);
    fp.arm('leader.beforeFlush', { skip: 2 });
    fp.hit('leader.durableBeforeQuorum', {});
    fp.hit('leader.beforeFlush', { n: 1 });
    fp.hit('leader.beforeFlush', { n: 2 });
    assert.equal(fired.length, 0);
    fp.hit('leader.beforeFlush', { n: 3 });
    fp.hit('leader.beforeFlush', { n: 4 });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].context.n, 3);
    assert.equal(fp.status().armed, null);
    assert.match(fs.readFileSync(path.join(dir, 'marker.json'), 'utf8'), /^FAILPOINT .*"leader.beforeFlush"/);
    assert.equal(SITES.length, 6);
});

test('group-commit sites fire on the leader only, inside their windows', async () => {
    await quiet(async () => {
        const { net, nodes, leader, calls } = cluster({ groupCommit: { maxEntries: 1024, maxDelayMs: 0, metaIntervalMs: 100 } });
        const write = leader.clientAppend({ op: 'set', key: 'k', value: 1 });
        await turn();
        const before = named(calls, 'leader.beforeFlush');
        assert.ok(before.length >= 1);
        assert.ok(before.every((c) => c.context.state === 'LEADER' && c.context.pendingEntries > 0));
        const durable = named(calls, 'leader.durableBeforeQuorum');
        assert.ok(durable.length >= 1);
        assert.ok(durable.every((c) => c.context.durableLength - 1 > c.context.commitIndex));
        let answered = false;
        void write.then(() => { answered = true; });
        for (let round = 0; round < 10; round += 1) {
            await net.deliverAll('http://a');
            await net.deliverAll('http://b');
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const committed = named(calls, 'leader.committedBeforeReply');
        assert.ok(committed.length >= 1);
        assert.ok(answered);
        assert.ok(calls.every((c) => c.context.replicaId === 'l'), 'followers never hit a leader site');
        nodes.forEach((node) => node.stop());
    });
});

test('the client is not answered when committedBeforeReply fires', async () => {
    await quiet(async () => {
        let answeredAtFire = null;
        let answered = false;
        const { net, nodes, leader } = cluster({
            failpoint: (name) => { if (name === 'leader.committedBeforeReply' && answeredAtFire === null) answeredAtFire = answered; },
        });
        const write = leader.clientAppend({ op: 'set', key: 'k', value: 1 });
        void write.then(() => { answered = true; });
        for (let round = 0; round < 10; round += 1) {
            await net.deliverAll('http://a');
            await net.deliverAll('http://b');
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await write;
        assert.equal(answeredAtFire, false);
        nodes.forEach((node) => node.stop());
    });
});

test('pipelined and batched sites see requests still in flight / multi-entry batches', async () => {
    await quiet(async () => {
        const { net, nodes, leader, calls } = cluster({
            pipeline: { maxInflight: 8 },
            replicationBatch: { maxEntries: 2, maxBytes: 1 << 20, coalesce: true },
        });
        await net.deliverAll('http://a');
        await net.deliverAll('http://b');
        for (let i = 0; i < 9; i += 1) void leader.clientAppend({ op: 'set', key: `k${i}`, value: i });
        await turn();
        await net.deliverAll('http://a');
        const pipelined = named(calls, 'leader.pipelinedInflight');
        assert.ok(pipelined.length >= 1);
        assert.ok(pipelined.every((c) => c.context.stillInflight > 0));
        const batched = named(calls, 'leader.batchedReplication');
        assert.ok(batched.length >= 1);
        assert.ok(batched.every((c) => c.context.carried > 1));
        nodes.forEach((node) => node.stop());
    });
});

test('with no failpoint hook the engine never calls one', async () => {
    await quiet(async () => {
        const { nodes, leader } = cluster({ failpoint: null, groupCommit: { maxEntries: 8, maxDelayMs: 0, metaIntervalMs: 50 } });
        void leader.clientAppend({ op: 'set', key: 'k', value: 1 });
        await turn();
        assert.equal(leader._failpoint, null);
        nodes.forEach((node) => node.stop());
    });
});
