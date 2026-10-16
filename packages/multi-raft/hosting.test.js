'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const { RangeDirectory, staticDescriptors } = require('./descriptors');
const { RangeStateMachine, STALE_RANGE_EPOCH } = require('./range-state-machine');
const { MultiRaftNode, groupUrl } = require('./multi-raft-node');
const { createMultiRaftServer } = require('./http-server');
const { VirtualClock, SimNetwork, Rng } = require('../../sim/simulator');
const { MemoryStableStore, MemoryLogStore } = require('../../sim/cluster');

const NODE_IDS = ['n1', 'n2', 'n3'];
const directory = () => new RangeDirectory(staticDescriptors({ boundaries: ['h', 'p'], replicas: NODE_IDS }));
const quiet = () => { const log = console.log; console.log = () => {}; return () => { console.log = log; }; };

const routed = (overrides = {}) => ({
    op: 'set', key: 'orange', value: 'v1', clientId: 'c1', seqNo: 1, rangeId: 'r2', expectedRangeEpoch: 1, ...overrides,
});

test('a routed write applies once and is recorded in the ledger', () => {
    const sm = new RangeStateMachine({ descriptor: directory().get('r2') });
    const result = sm.apply({ index: 0, term: 1, data: routed() });
    assert.equal(result.ok, true);
    assert.equal(sm.get('orange').value, 'v1');
    assert.deepEqual(sm.applications().map((r) => [r.logicalRequestId, r.rangeId, r.epoch, r.index, r.outcome]),
        [['c1#1', 'r2', 1, 0, 'applied']]);
    assert.match(sm.ledger[0].operationDigest, /^[0-9a-f]{64}$/);
});

test('the fence rejects at apply, mutates nothing, and says why (I5)', () => {
    const descriptor = directory().get('r2');
    const sm = new RangeStateMachine({ descriptor });
    sm.apply({ index: 0, term: 1, data: routed() });
    const before = JSON.stringify(sm.list());
    const cases = [
        [routed({ seqNo: 2, rangeId: 'r1' }), /range r1 is not r2/],
        [routed({ seqNo: 3, expectedRangeEpoch: 2 }), /epoch 2 is not 1/],
        [routed({ seqNo: 4, expectedRangeEpoch: 0 }), /epoch 0 is not 1/],
        [routed({ seqNo: 5, key: 'apple' }), /outside the range/],
        [routed({ seqNo: 6, key: 'p' }), /outside the range/],
        [routed({ seqNo: undefined }), /missing LogicalRequestId/],
        [routed({ seqNo: 7, op: 'lease-acquire' }), /not supported in a range/],
        [{ op: 'set', key: 'orange', value: 'x', clientId: 'c1', seqNo: 8 }, /unrouted operation/],
    ];
    cases.forEach(([data, reason], i) => {
        const result = sm.apply({ index: i + 1, term: 1, data });
        assert.equal(result.ok, false);
        assert.equal(result.error, STALE_RANGE_EPOCH);
        assert.match(result.reason, reason);
        assert.equal(result.descriptor.rangeId, 'r2', 'the descriptor rides along so a router can refresh');
        assert.deepEqual(sm.resultFor(i + 1), result, 'the client is answered with the rejection');
    });
    assert.equal(JSON.stringify(sm.list()), before, 'no rejected entry changed state');
    assert.equal(sm.applications().length, 1);
    assert.equal(sm.ledger.filter((r) => r.outcome === 'rejected').length, cases.length);
    assert.equal(sm.lastAppliedIndex, cases.length, 'a rejected entry still advances the applied index');
});

test('replaying the log rebuilds the same state and ledger (restart determinism)', () => {
    const descriptor = directory().get('r3');
    const entries = [
        { index: 0, term: 1, data: { op: 'noop' } },
        { index: 1, term: 1, data: routed({ rangeId: 'r3', key: 'pear', value: 1 }) },
        { index: 2, term: 1, data: routed({ rangeId: 'r3', key: 'apple', seqNo: 2 }) },
        { index: 3, term: 2, data: routed({ rangeId: 'r3', key: 'plum', value: 3, seqNo: 3 }) },
        { index: 4, term: 2, data: routed({ rangeId: 'r3', key: 'pear', op: 'delete', seqNo: 4 }) },
    ];
    const run = () => { const sm = new RangeStateMachine({ descriptor }); for (const e of entries) sm.apply(e); return sm; };
    const a = run();
    const b = run();
    assert.deepEqual(b.list(), a.list());
    assert.deepEqual(b.ledger, a.ledger);
    assert.deepEqual(a.list().map((r) => r.key), ['plum']);
    assert.equal(a.applications().length, 3);
});

/** Three nodes, three ranges, on the simulator's virtual clock and network. */
function simulatedNodes({ seed = 7 } = {}) {
    const clock = new VirtualClock();
    const network = new SimNetwork(clock, new Rng(seed), { minLatency: 1, maxLatency: 8 });
    const origins = NODE_IDS.map((_, i) => `http://node${i}:5000`);
    const stores = new Map();
    const dir = directory();
    const nodes = NODE_IDS.map((nodeId, i) => {
        const jitter = new Rng(seed * 31 + i);
        const node = new MultiRaftNode({
            nodeId, origin: origins[i], memberOrigins: origins, directory: dir,
            transport: network.forNode(origins[i]),
            storageFor: (rangeId) => {
                const key = `${nodeId}:${rangeId}`;
                if (!stores.has(key)) stores.set(key, { stableStore: new MemoryStableStore(), logStore: new MemoryLogStore() });
                return { ...stores.get(key), storagePath: false };
            },
            raftOptions: { electionTimeoutMin: 150, electionTimeoutMax: 300, heartbeatInterval: 40, commitTimeoutMs: 1500 },
            groupOptions: () => ({ clock, randomElectionTimeout: (min, max) => jitter.range(min, Math.max(min, max - 1)) }),
        });
        network.register(origins[i], node.handlers());
        return node;
    });
    const leaderOf = (rangeId) => nodes.find((n) => n.groups.get(rangeId) && !n.groups.get(rangeId).crashed
        && n.groups.get(rangeId).raft.isLeader()) || null;
    const run = async (ms) => clock.runFor(ms);
    return { clock, network, nodes, origins, leaderOf, run };
}

test('three ranges elect leaders and commit independently on one set of nodes', async () => {
    const restore = quiet();
    const sim = simulatedNodes();
    try {
        await sim.run(3000);
        const keys = { r1: 'apple', r2: 'orange', r3: 'pear' };
        const writes = Object.entries(keys).map(([rangeId, key], i) => {
            const leader = sim.leaderOf(rangeId);
            assert.ok(leader, `${rangeId} has a leader`);
            return leader.write({ rangeId, expectedRangeEpoch: 1, clientId: 'c', seqNo: i + 1, op: 'set', key, value: i });
        });
        await sim.run(2000);
        const outcomes = await Promise.all(writes);
        assert.deepEqual(outcomes.map((o) => o.status), ['OK', 'OK', 'OK']);
        for (const [rangeId, key] of Object.entries(keys)) {
            for (const node of sim.nodes) {
                assert.equal(node.state(rangeId)[key] !== undefined, true, `${node.nodeId} applied ${key} in ${rangeId}`);
                assert.equal(Object.keys(node.state(rangeId)).length, 1, `${rangeId} holds only its own key`);
            }
        }
        // The groups are separate Raft instances with group-scoped identities.
        assert.equal(sim.nodes[0].groups.get('r1').raft.nodeUrl, groupUrl(sim.origins[0], 'r1'));
    } finally {
        for (const node of sim.nodes) node.stop();
        restore();
    }
});

test('admission rejects a wrong epoch, a foreign range and a follower write without appending', async () => {
    const restore = quiet();
    const sim = simulatedNodes({ seed: 11 });
    try {
        await sim.run(3000);
        const leader = sim.leaderOf('r2');
        const logLength = leader.groups.get('r2').raft.log.length;
        const stale = await leader.write(routed({ expectedRangeEpoch: 2 }));
        assert.equal(stale.status, STALE_RANGE_EPOCH);
        assert.equal(stale.at, 'admission');
        const foreign = await leader.write(routed({ rangeId: 'r9' }));
        assert.equal(foreign.status, STALE_RANGE_EPOCH);
        const outside = await leader.write(routed({ key: 'zebra' }));
        assert.equal(outside.status, STALE_RANGE_EPOCH);
        assert.equal(leader.groups.get('r2').raft.log.length, logLength, 'nothing was appended');
        const follower = sim.nodes.find((n) => n !== leader);
        const redirected = await follower.write(routed());
        assert.equal(redirected.status, 'NOT_LEADER');
        assert.equal(redirected.leaderHint, leader.origin);
    } finally {
        for (const node of sim.nodes) node.stop();
        restore();
    }
});

test('crashing one range replica leaves the other ranges on that node serving', async () => {
    const restore = quiet();
    const sim = simulatedNodes({ seed: 13 });
    try {
        await sim.run(3000);
        const leaderR1 = sim.leaderOf('r1');
        assert.ok(leaderR1.crashGroup('r1'));
        assert.throws(() => leaderR1.rpc('r1', 'append-entries', {}), /ECONNREFUSED/);
        assert.equal((await leaderR1.write(routed({ rangeId: 'r1', key: 'apple' }))).status, 'UNAVAILABLE');
        await sim.run(3000);
        const newLeader = sim.leaderOf('r1');
        assert.ok(newLeader && newLeader !== leaderR1, 'r1 elected a new leader on another node');
        // The crashed node still hosts working replicas of r2 and r3.
        assert.equal(leaderR1.groups.get('r2').crashed, false);
        const write = sim.leaderOf('r3').write(routed({ rangeId: 'r3', key: 'pear', seqNo: 9 }));
        await sim.run(1000);
        assert.equal((await write).status, 'OK');
        assert.ok(leaderR1.restartGroup('r1'));
        await sim.run(2000);
        assert.equal(leaderR1.groups.get('r1').crashed, false);
    } finally {
        for (const node of sim.nodes) node.stop();
        restore();
    }
});

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
        server.on('error', reject);
    });
}

test('over real HTTP, range-prefixed endpoints elect, commit, read and fence', async (t) => {
    const restore = quiet();
    const ports = [await freePort(), await freePort(), await freePort()];
    const origins = ports.map((p) => `http://127.0.0.1:${p}`);
    const dir = directory();
    const nodes = NODE_IDS.map((nodeId, i) => new MultiRaftNode({
        nodeId, origin: origins[i], memberOrigins: origins, directory: dir,
        storageFor: () => ({ stableStore: new MemoryStableStore(), logStore: new MemoryLogStore(), storagePath: false }),
        raftOptions: { electionTimeoutMin: 150, electionTimeoutMax: 300, heartbeatInterval: 40 },
    }));
    const servers = nodes.map((node) => createMultiRaftServer(node));
    await Promise.all(servers.map((s, i) => new Promise((r) => s.listen(ports[i], '127.0.0.1', r))));
    t.after(async () => {
        for (const node of nodes) node.stop();
        await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); })));
        restore();
    });
    const json = async (url, init) => { const res = await fetch(url, init); return { status: res.status, body: await res.json() }; };
    const leaderOrigin = async (rangeId) => {
        for (let i = 0; i < 60; i += 1) {
            for (const origin of origins) {
                const { body } = await json(`${origin}/status`);
                if (body.ranges.find((r) => r.rangeId === rangeId && r.leader)) return origin;
            }
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`no leader for ${rangeId}`);
    };
    const post = (origin, rangeId, body) => json(`${origin}/ranges/${rangeId}/kv`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    for (const [rangeId, key] of [['r1', 'apple'], ['r2', 'orange'], ['r3', 'pear']]) {
        const origin = await leaderOrigin(rangeId);
        const write = await post(origin, rangeId, { expectedRangeEpoch: 1, clientId: 'h', seqNo: key.length, op: 'set', key, value: key });
        assert.equal(write.status, 200, JSON.stringify(write.body));
        const read = await json(`${origin}/ranges/${rangeId}/kv/${key}?epoch=1`);
        assert.deepEqual([read.status, read.body.value], [200, key]);
        const stale = await post(origin, rangeId, { expectedRangeEpoch: 7, clientId: 'h', seqNo: 99, op: 'set', key, value: 'x' });
        assert.equal(stale.status, 409);
        assert.equal(stale.body.error, STALE_RANGE_EPOCH);
        const staleRead = await json(`${origin}/ranges/${rangeId}/kv/${key}?epoch=7`);
        assert.equal(staleRead.status, 409);
    }
    const ledger = await json(`${await leaderOrigin('r2')}/ranges/r2/ledger`);
    assert.deepEqual(ledger.body.ledger.filter((r) => r.outcome === 'applied').map((r) => r.logicalRequestId), ['h#6']);
});
