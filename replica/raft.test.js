const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { RaftNode, STATES } = require('./raft');

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
        assert.equal(first.log.length, 1);
        first.stop();

        const restarted = new RaftNode({
            replicaId: 'replica1',
            peers: [],
            storagePath: temp.file,
            autoStart: false,
        });
        assert.equal(restarted.currentTerm, 1);
        assert.equal(restarted.log.length, 1);
        assert.equal(restarted.commitIndex, 0);
        assert.equal(restarted.lastApplied, 0);
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
