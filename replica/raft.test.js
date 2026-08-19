const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { RaftNode, STATES } = require('./raft');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A transport where every RPC succeeds but takes `latencyMs` to do it. */
function slowTransport(latencyMs) {
    return {
        post: async (url, body) => {
            await sleep(latencyMs);
            if (url.endsWith('/append-entries')) {
                const matchIndex = body.prevLogIndex + body.entries.length;
                return { data: { term: body.term, success: true, matchIndex, logLength: matchIndex + 1 } };
            }
            return { data: { term: body.term, voteGranted: true } };
        },
    };
}

function temporaryState(name) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `miniraft-${name}-`));
    return {
        directory,
        file: path.join(directory, 'state.json'),
        cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
}

test('persists term and vote before granting RequestVote', () => {
    const temp = temporaryState('vote');
    try {
        const node = new RaftNode({
            replicaId: 'replica1',
            peers: ['http://replica2:5002', 'http://replica3:5003'],
            storagePath: temp.file,
            autoStart: false,
        });

        const response = node.handleRequestVote({
            term: 4,
            candidateId: 'replica2',
            lastLogIndex: -1,
            lastLogTerm: 0,
        });
        const durable = JSON.parse(fs.readFileSync(temp.file, 'utf8'));

        assert.equal(response.voteGranted, true);
        assert.equal(durable.currentTerm, 4);
        assert.equal(durable.votedFor, 'replica2');
    } finally {
        temp.cleanup();
    }
});

test('restores a committed log after restart and deduplicates client retries', async () => {
    const temp = temporaryState('restart');
    try {
        const first = new RaftNode({
            replicaId: 'replica1',
            peers: [],
            storagePath: temp.file,
            autoStart: false,
        });
        await first._startElection();

        const command = {
            id: 'stroke-1',
            clientId: 'browser-a',
            seqNo: 1,
            tool: 'pen',
            points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        };
        const appended = await first.clientAppend(command);
        const duplicate = await first.clientAppend(command);

        assert.equal(appended.committed, true);
        assert.equal(duplicate.committed, true);
        assert.equal(duplicate.duplicate, true);
        // Two entries: the Raft §8 no-op this leader appended on election, then
        // the client command. The duplicate did not add a third.
        assert.equal(first.log.length, 2);
        assert.equal(first.log[0].data.op, 'noop');
        first.stop();

        const restarted = new RaftNode({
            replicaId: 'replica1',
            peers: [],
            storagePath: temp.file,
            autoStart: false,
        });
        assert.equal(restarted.currentTerm, 1);
        assert.equal(restarted.log.length, 2);
        assert.equal(restarted.commitIndex, 1);
        assert.equal(restarted.lastApplied, 1);
    } finally {
        temp.cleanup();
    }
});

test('uses a dynamic majority for larger clusters', () => {
    const node = new RaftNode({
        replicaId: 'replica1',
        peers: ['p2', 'p3', 'p4', 'p5'],
        storagePath: false,
        autoStart: false,
    });

    assert.equal(node.clusterSize, 5);
    assert.equal(node.quorumSize, 3);
});

test('does not commit an older-term entry by replica count alone', () => {
    const node = new RaftNode({
        replicaId: 'replica1',
        peers: ['p2', 'p3', 'p4', 'p5'],
        storagePath: false,
        autoStart: false,
    });
    node.state = STATES.LEADER;
    node.currentTerm = 3;
    node.log = [
        { term: 2, index: 0, data: { value: 'a' } },
        { term: 2, index: 1, data: { value: 'b' } },
        { term: 3, index: 2, data: { value: 'c' } },
    ];
    node.matchIndex = { p2: 1, p3: 1, p4: -1, p5: -1 };

    node._advanceCommitIndex();
    assert.equal(node.commitIndex, -1);

    node.matchIndex.p2 = 2;
    node.matchIndex.p3 = 2;
    node._advanceCommitIndex();
    assert.equal(node.commitIndex, 2);
});

test('rebuilds the keyspace by replaying the committed log after a restart', async () => {
    const temp = temporaryState('replay');
    try {
        const first = new RaftNode({
            replicaId: 'replica1',
            peers: [],
            storagePath: temp.file,
            autoStart: false,
        });
        await first._startElection();

        await first.clientAppend({ op: 'set', key: 'model/current', value: 'clip-v2' });
        const claim = await first.clientAppend({
            op: 'lease-acquire', key: 'shard/0', holder: 'pod-a', ttlMs: 60000,
        });
        assert.equal(claim.result.ok, true);
        assert.equal(first.stateMachine.get('model/current').value, 'clip-v2');
        first.stop();

        const restarted = new RaftNode({
            replicaId: 'replica1',
            peers: [],
            storagePath: temp.file,
            autoStart: false,
        });

        // This is the bug the old lastApplied persistence hid: the node used to
        // come back believing it had applied everything while holding an empty
        // keyspace.
        // no-op + set + lease-acquire
        assert.equal(restarted.metrics.replayedEntries, 3);
        assert.equal(restarted.stateMachine.get('model/current').value, 'clip-v2');
        assert.equal(restarted.stateMachine.leaseInfo('shard/0').holder, 'pod-a');
        assert.deepEqual(restarted.stateMachine.snapshot(), first.stateMachine.snapshot());
        restarted.stop();
    } finally {
        temp.cleanup();
    }
});

test('a retried cas returns the original verdict rather than re-running it', async () => {
    const temp = temporaryState('dedup-cas');
    try {
        const node = new RaftNode({
            replicaId: 'replica1',
            peers: [],
            storagePath: temp.file,
            autoStart: false,
        });
        await node._startElection();

        const command = {
            op: 'cas', key: 'shard/0', expectRev: 0, value: 'pod-a',
            clientId: 'pod-a', seqNo: 1,
        };
        const first = await node.clientAppend(command);
        // The client never saw the response and retries. Re-evaluating the
        // comparison now would report failure for a swap it actually won.
        const retry = await node.clientAppend(command);

        assert.equal(first.result.ok, true);
        assert.equal(retry.duplicate, true);
        assert.equal(retry.result.ok, true);
        assert.equal(node.log.length, 2, 'the no-op plus one cas; the retry added nothing');
        node.stop();
    } finally {
        temp.cleanup();
    }
});

test('a client write that races an in-flight heartbeat still reports committed', async () => {
    // Replication to a peer is skipped while a request to that peer is already
    // outstanding. With heartbeats slower than the heartbeat interval, every
    // client write lands during one — and used to be reported uncommitted,
    // pushing clients into retrying writes that had already succeeded.
    const node = new RaftNode({
        replicaId: 'replica1',
        peers: ['http://p2', 'http://p3'],
        storagePath: false,
        autoStart: false,
        transport: slowTransport(60),
        heartbeatInterval: 25,
    });

    await node._startElection();
    assert.equal(node.state, STATES.LEADER);
    await sleep(40); // guarantee a heartbeat is mid-flight

    const result = await node.clientAppend({ op: 'set', key: 'k', value: 1 });
    assert.equal(result.committed, true);
    assert.equal(result.result.ok, true);
    node.stop();
});

test('a pending write is answered immediately when the leader steps down', async () => {
    const node = new RaftNode({
        replicaId: 'replica1',
        peers: ['http://p2', 'http://p3'],
        storagePath: false,
        autoStart: false,
        transport: { post: () => new Promise(() => {}) }, // never resolves
        commitTimeoutMs: 10000,
    });

    node.state = STATES.LEADER;
    node.currentTerm = 1;
    for (const peer of node.peers) {
        node.nextIndex[peer] = 0;
        node.matchIndex[peer] = -1;
    }

    const pending = node.clientAppend({ op: 'set', key: 'k', value: 1 });
    await sleep(20);

    // A higher term arrives. This entry can never commit under this node's
    // authority, so holding the client for the full 10s timeout would be
    // pointless.
    const startedAt = Date.now();
    node._becomeFollower(2, 'replica2');
    const result = await pending;

    assert.equal(result.committed, false);
    assert.ok(Date.now() - startedAt < 1000, 'answered on step-down, not on timeout');
    node.stop();
});

test('refuses to truncate committed entries', () => {
    const node = new RaftNode({
        replicaId: 'replica2',
        peers: ['p1', 'p3'],
        storagePath: false,
        autoStart: false,
    });
    node.currentTerm = 2;
    node.log = [
        { term: 1, index: 0, data: { value: 'a' } },
        { term: 1, index: 1, data: { value: 'b' } },
    ];
    node.commitIndex = 1;

    // A leader claiming index 1 holds a different term would be asking this
    // follower to discard an entry a majority already acknowledged.
    assert.throws(
        () => node.handleAppendEntries({
            term: 2,
            leaderId: 'replica1',
            prevLogIndex: 0,
            prevLogTerm: 1,
            entries: [{ term: 2, index: 1, data: { value: 'divergent' } }],
            leaderCommit: 1,
        }),
        /must never be discarded/,
    );
});

test('empty AppendEntries heartbeat performs consistency checks and advances commit', () => {
    const node = new RaftNode({
        replicaId: 'replica2',
        peers: ['p1', 'p3'],
        storagePath: false,
        autoStart: false,
    });
    node.currentTerm = 2;
    node.log = [
        { term: 1, index: 0, data: { value: 'a' } },
        { term: 2, index: 1, data: { value: 'b' } },
    ];

    const rejected = node.handleAppendEntries({
        term: 2,
        leaderId: 'replica1',
        prevLogIndex: 1,
        prevLogTerm: 1,
        entries: [],
        leaderCommit: 1,
    });
    assert.equal(rejected.success, false);
    assert.equal(node.commitIndex, -1);

    const accepted = node.handleAppendEntries({
        term: 2,
        leaderId: 'replica1',
        prevLogIndex: 1,
        prevLogTerm: 2,
        entries: [],
        leaderCommit: 1,
    });
    assert.equal(accepted.success, true);
    assert.equal(node.commitIndex, 1);
    assert.equal(node.lastApplied, 1);
});

test('PreVote does not increase the term when an isolated node cannot reach a quorum', async () => {
    const node = new RaftNode({
        replicaId: 'replica1',
        peers: ['http://p2', 'http://p3'],
        storagePath: false,
        autoStart: false,
        transport: { post: async () => { throw new Error('partitioned'); } },
    });

    await node._startPreVote();
    await node._startPreVote();

    assert.equal(node.currentTerm, 0);
    assert.equal(node.state, STATES.FOLLOWER);
    assert.equal(node.metrics.preVotesTotal, 2);
    assert.equal(node.metrics.electionsTotal, 0);
    node.stop();
});

test('PreVote reaches a real election only after a majority grants it', async () => {
    const node = new RaftNode({
        replicaId: 'replica1',
        peers: ['http://p2', 'http://p3'],
        storagePath: false,
        autoStart: false,
        transport: {
            post: async (url, body) => {
                if (url.endsWith('/pre-vote')) {
                    return { data: { term: 0, preVoteGranted: true } };
                }
                if (url.endsWith('/request-vote')) {
                    return { data: { term: body.term, voteGranted: true } };
                }
                const matchIndex = body.prevLogIndex + body.entries.length;
                return { data: { term: body.term, success: true, matchIndex } };
            },
        },
    });

    await node._startPreVote();

    assert.equal(node.currentTerm, 1);
    assert.equal(node.state, STATES.LEADER);
    assert.equal(node.metrics.preVotesTotal, 1);
    assert.equal(node.metrics.electionsTotal, 1);
    node.stop();
});

test('granting a PreVote is read-only and rejects a candidate while a leader is fresh', () => {
    const node = new RaftNode({
        replicaId: 'replica2',
        nodeUrl: 'http://p2',
        peers: ['http://p1', 'http://p3'],
        storagePath: false,
        autoStart: false,
    });
    const before = { term: node.currentTerm, votedFor: node.votedFor };

    const granted = node.handlePreVote({
        term: 1,
        candidateId: 'replica1',
        candidateUrl: 'http://p1',
        lastLogIndex: -1,
        lastLogTerm: 0,
    });
    assert.equal(granted.preVoteGranted, true);
    assert.deepEqual({ term: node.currentTerm, votedFor: node.votedFor }, before);

    node.leaderId = 'replica3';
    node.lastLeaderContactAt = node._clock.now();
    const rejected = node.handlePreVote({
        term: 1,
        candidateId: 'replica1',
        candidateUrl: 'http://p1',
        lastLogIndex: -1,
        lastLogTerm: 0,
    });
    assert.equal(rejected.preVoteGranted, false);
    assert.deepEqual({ term: node.currentTerm, votedFor: node.votedFor }, before);
    node.stop();
});
