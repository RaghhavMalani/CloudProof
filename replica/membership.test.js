const assert = require('node:assert/strict');
const test = require('node:test');

const { RaftNode, STATES } = require('./raft');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A transport where every peer accepts everything, instantly. */
function agreeableTransport(latencyMs = 1) {
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

/** A transport where one named peer never responds. */
function transportExcluding(deadUrl) {
    return {
        post: async (url, body) => {
            if (url.startsWith(deadUrl)) {
                await sleep(5);
                throw new Error('ETIMEDOUT');
            }
            await sleep(1);
            if (url.endsWith('/append-entries')) {
                const matchIndex = body.prevLogIndex + body.entries.length;
                return { data: { term: body.term, success: true, matchIndex, logLength: matchIndex + 1 } };
            }
            return { data: { term: body.term, voteGranted: true } };
        },
    };
}

async function leaderOf(options = {}) {
    const node = new RaftNode({
        replicaId: 'n1',
        nodeUrl: 'http://n1',
        members: ['http://n1', 'http://n2', 'http://n3'],
        storagePath: false,
        autoStart: false,
        transport: agreeableTransport(),
        ...options,
    });
    await node._startElection();
    assert.equal(node.state, STATES.LEADER, 'setup failed to elect');
    return node;
}

test('the configuration comes from the log, not from the constructor', async () => {
    const node = await leaderOf();
    assert.deepEqual(node.members.sort(), ['http://n1', 'http://n2', 'http://n3']);
    assert.equal(node.quorumSize, 2);

    await node.addServer('http://n4', { catchUpTimeoutMs: 2000 });
    assert.equal(node.members.length, 4);
    assert.equal(node.quorumSize, 3, 'quorum must grow with the cluster');

    // The change is durable in the log, which is what a restarting node reads.
    const configEntries = node.log.filter((e) => e.data && e.data.op === 'config');
    assert.ok(configEntries.length >= 2, 'both the learner and promotion steps are logged');
    assert.deepEqual(configEntries.at(-1).data.members.sort(),
        ['http://n1', 'http://n2', 'http://n3', 'http://n4']);
    node.stop();
});

test('a joiner is a learner first and is not counted for quorum', async () => {
    // n4 is unreachable. If the implementation admitted it straight into the
    // voter set, quorum would jump to 3 of 4 with one member that cannot
    // acknowledge — and the cluster would stall. It must stay at 2 of 3.
    const node = await leaderOf({ transport: transportExcluding('http://n4') });

    const quorumBefore = node.quorumSize;
    const result = await node.addServer('http://n4', { catchUpTimeoutMs: 300 });

    assert.equal(result.ok, false, 'a joiner that never catches up must not be promoted');
    assert.equal(node.quorumSize, quorumBefore, 'quorum must not have grown');
    assert.ok(!node.members.includes('http://n4'), 'must not be a voter');
    assert.ok(!node.learners.includes('http://n4'), 'a failed join must not leave debris');
    node.stop();
});

test('a learner receives the log but never votes or campaigns', () => {
    const learner = new RaftNode({
        replicaId: 'n4',
        nodeUrl: 'http://n4',
        members: ['http://n1', 'http://n2', 'http://n3'],
        storagePath: false,
        autoStart: false,
        transport: agreeableTransport(),
    });

    assert.equal(learner.isVoter, false);
    // Even asked directly, it must not put itself forward.
    learner._startElection();
    assert.notEqual(learner.state, STATES.CANDIDATE,
        'a non-voter that campaigns can disrupt a cluster it is not part of');
    learner.stop();
});

test('only one configuration change may be in flight', async () => {
    const node = await leaderOf({ transport: transportExcluding('http://never') });

    // Leave an uncommitted config entry in the log by hand.
    node._appendToLog([{
        term: node.currentTerm,
        index: node.log.length,
        ts: 1,
        data: { op: 'config', members: [...node.members, 'http://n5'], learners: [] },
    }]);

    await assert.rejects(
        () => node.addServer('http://n6'),
        /already in flight/,
        'overlapping changes reintroduce the disjoint-majority hazard',
    );
    node.stop();
});

test('a leader that removes itself keeps serving until the change commits, then steps down', async () => {
    const node = await leaderOf();
    assert.equal(node.state, STATES.LEADER);

    const result = await node.removeServer('http://n1');
    assert.equal(result.ok, true);
    assert.ok(!node.members.includes('http://n1'), 'it is no longer a member');
    assert.equal(node.isVoter, false);
    assert.equal(node.state, STATES.FOLLOWER,
        'it must not keep leading a cluster it has been removed from');
    node.stop();
});

test('refuses to remove the last remaining member', async () => {
    const node = new RaftNode({
        replicaId: 'solo', nodeUrl: 'http://solo', members: ['http://solo'],
        storagePath: false, autoStart: false, transport: agreeableTransport(),
    });
    await node._startElection();
    const result = await node.removeServer('http://solo');
    assert.equal(result.ok, false);
    assert.match(result.error, /last member/);
    node.stop();
});

test('a removed server cannot disrupt a leader that is still being heard', () => {
    const follower = new RaftNode({
        replicaId: 'n2', nodeUrl: 'http://n2',
        members: ['http://n1', 'http://n2', 'http://n3'],
        storagePath: false, autoStart: false, transport: agreeableTransport(),
        electionTimeoutMin: 500,
    });

    // A live leader is replicating to it.
    follower.handleAppendEntries({
        term: 5, leaderId: 'n1', leaderUrl: 'http://n1',
        prevLogIndex: -1, prevLogTerm: 0, entries: [], leaderCommit: -1,
    });
    assert.equal(follower.leaderId, 'n1');

    // A removed server, campaigning at a much higher term. Accepting this would
    // force the healthy leader to step down for nothing — and the stranger
    // would do it again, forever.
    const response = follower.handleRequestVote({
        term: 99, candidateId: 'ghost', lastLogIndex: 99, lastLogTerm: 99,
    });

    assert.equal(response.voteGranted, false);
    assert.match(response.reason, /leader is still alive/);
    assert.equal(follower.currentTerm, 5, 'the term must not have been bumped by the intruder');
    follower.stop();
});

test('the disruption rule expires, so a genuinely dead leader is replaceable', () => {
    let now = 1000;
    const clock = {
        now: () => now,
        setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    };
    const follower = new RaftNode({
        replicaId: 'n2', nodeUrl: 'http://n2',
        members: ['http://n1', 'http://n2', 'http://n3'],
        storagePath: false, autoStart: false, transport: agreeableTransport(),
        clock, electionTimeoutMin: 500,
    });

    follower.handleAppendEntries({
        term: 5, leaderId: 'n1', leaderUrl: 'http://n1',
        prevLogIndex: -1, prevLogTerm: 0, entries: [], leaderCommit: -1,
    });
    assert.equal(follower.handleRequestVote({ term: 6, candidateId: 'n3', lastLogIndex: -1, lastLogTerm: 0 }).voteGranted, false);

    // Past the minimum election timeout with no further contact, the leader is
    // presumed gone and normal voting resumes. Without this the rule would
    // permanently freeze the cluster after a real leader failure.
    now += 600;
    const later = follower.handleRequestVote({ term: 6, candidateId: 'n3', lastLogIndex: -1, lastLogTerm: 0 });
    assert.equal(later.voteGranted, true);
    follower.stop();
});

test('a truncated configuration entry rolls the configuration back', () => {
    const node = new RaftNode({
        replicaId: 'n2', nodeUrl: 'http://n2',
        members: ['http://n1', 'http://n2', 'http://n3'],
        storagePath: false, autoStart: false, transport: agreeableTransport(),
    });

    node._appendToLog([{
        term: 1, index: 0, ts: 1,
        data: { op: 'config', members: ['http://n1', 'http://n2', 'http://n3', 'http://n9'], learners: [] },
    }]);
    assert.equal(node.members.length, 4, 'a config entry is live as soon as it is appended');

    // The entry loses an election and is replaced. Because configuration takes
    // effect on append rather than commit, it must also *revert* on truncation
    // — otherwise this node enforces a membership the cluster discarded.
    node._truncateLogFrom(0);
    assert.equal(node.members.length, 3);
    assert.ok(!node.members.includes('http://n9'));
    node.stop();
});

test('every configuration overlaps its predecessor in a majority', async () => {
    // The safety property single-server changes exist to provide: consecutive
    // configurations always share enough members that two disjoint majorities
    // cannot both elect a leader. Asserted across a whole sequence of changes.
    const node = await leaderOf();
    const seen = [[...node.members]];

    await node.addServer('http://n4', { catchUpTimeoutMs: 2000 });
    seen.push([...node.members]);
    await node.addServer('http://n5', { catchUpTimeoutMs: 2000 });
    seen.push([...node.members]);
    await node.removeServer('http://n2');
    seen.push([...node.members]);

    for (let i = 1; i < seen.length; i += 1) {
        const before = new Set(seen[i - 1]);
        const after = seen[i];
        const shared = after.filter((u) => before.has(u)).length;
        const majorityBefore = Math.floor(seen[i - 1].length / 2) + 1;
        const majorityAfter = Math.floor(after.length / 2) + 1;
        // Any majority of the old and any majority of the new must intersect.
        assert.ok(
            majorityBefore + majorityAfter > seen[i - 1].length + after.length - shared,
            `configurations ${i - 1} and ${i} admit disjoint majorities: `
            + `${seen[i - 1].join(',')} -> ${after.join(',')}`,
        );
    }
    node.stop();
});
