const assert = require('node:assert/strict');
const test = require('node:test');

const { RaftNode, STATES } = require('./raft');
const { MemoryStableStore, MemoryLogStore } = require('../sim/cluster');
const { ManualNetwork } = require('../sim/manual-network');

const MEMBERS = ['http://l', 'http://a', 'http://b'];

/** Runs one committed write on a three-node cluster and returns everything logged. */
async function logsForOneWrite(options) {
    const lines = [];
    const log = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };
    try {
        const net = new ManualNetwork();
        const nodes = MEMBERS.map((url) => {
            const node = new RaftNode({
                replicaId: url.slice(7), nodeUrl: url, members: MEMBERS,
                stableStore: new MemoryStableStore(), logStore: new MemoryLogStore(), storagePath: false,
                autoStart: false, transport: net.transport(), commitTimeoutMs: 60000, ...options,
            });
            net.register(url, node);
            return node;
        });
        const [leader] = nodes;
        leader.state = STATES.CANDIDATE;
        leader.currentTerm = 1;
        leader._becomeLeader();
        leader._stopHeartbeat();
        const write = leader.clientAppend({ op: 'set', key: 'k', value: 1 });
        // Stop-and-wait replication sends an entry appended while a request
        // is outstanding from the commit broadcast timer, so let timers run
        // between delivery rounds.
        for (let round = 0; round < 10; round += 1) {
            await net.deliverAll('http://a');
            await net.deliverAll('http://b');
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const result = await write;
        for (const node of nodes) node.stop();
        return { result, lines };
    } finally {
        console.log = log;
    }
}

const perWrite = (lines) => lines.filter((line) => /Entry (persisted|appended)|Commit advanced/.test(line));

test('per-write log lines are on by default', async () => {
    const { result, lines } = await logsForOneWrite({});
    assert.equal(result.committed, true);
    // The leader's no-op and the client write each produce both lines.
    assert.ok(perWrite(lines).length >= 2, lines.join('\n'));
});

test('logHotPath: false drops only the per-write lines', async () => {
    const { result, lines } = await logsForOneWrite({ logHotPath: false });
    assert.equal(result.committed, true);
    assert.deepEqual(perWrite(lines), []);
    assert.ok(lines.some((line) => line.includes('*** LEADER')), 'leadership changes are still logged');
});
