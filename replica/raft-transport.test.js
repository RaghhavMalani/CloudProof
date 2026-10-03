const assert = require('node:assert/strict');
const test = require('node:test');

const {
    TYPES, VERSION, HEADER_BYTES, encodeRequest, encodeResponse, encodeError, decodeBody, FrameDecoder, CodecError,
} = require('./raft-codec');
const { FramedTcpTransport, createFramedTcpServer, raftHandlers } = require('./raft-transport');
const { RaftNode } = require('./raft');
const { entryJson } = require('./entry-codec');

function roundTrip(frame) {
    const [decoded] = new FrameDecoder().push(frame);
    return { ...decoded, value: decodeBody(decoded.type, decoded.body) };
}

const ENTRIES = [
    { term: 3, index: 7, ts: 1700000000123, data: { op: 'set', key: 'k', value: 'v' } },
    { term: 3, index: 8, ts: 1700000000124, data: { op: 'config', members: ['a', 'b'], learners: [] } },
    { term: 3, index: 9, ts: 1700000000125, data: { op: 'set', key: 'ünïcødé ✓', value: '𝄞   "quoted" \\ back' } },
    { term: 3, index: 10, data: { op: 'noop' } },
    { term: 3, index: 11, ts: 5, data: { op: 'set', key: 'big', value: 'x'.repeat(64 * 1024) } },
];

test('AppendEntries round-trips every field, including -1 indexes and entries without ts', () => {
    const body = {
        term: 3, leaderId: 'replica1', leaderUrl: 'http://127.0.0.1:17001',
        prevLogIndex: -1, prevLogTerm: 0, entries: ENTRIES, leaderCommit: -1,
    };
    const { type, streamId, value } = roundTrip(encodeRequest(TYPES.APPEND_ENTRIES, body, 42));
    assert.equal(type, TYPES.APPEND_ENTRIES);
    assert.equal(streamId, 42);
    assert.deepEqual(value, body);
    // The follower's decoded entries carry the sender's exact JSON, cached.
    assert.equal(entryJson(value.entries[2]), JSON.stringify(ENTRIES[2]));
});

test('a heartbeat with null leaderUrl and no entries round-trips', () => {
    const body = { term: 1, leaderId: 'l', leaderUrl: null, prevLogIndex: 4, prevLogTerm: 1, entries: [], leaderCommit: 4 };
    assert.deepEqual(roundTrip(encodeRequest(TYPES.APPEND_ENTRIES, body, 1)).value, body);
});

test('AppendEntries responses keep present fields, omit absent ones, and carry extras', () => {
    const cases = [
        { term: 5, success: true, matchIndex: 12, logLength: 13 },
        { term: 5, success: false, conflictIndex: 3, conflictTerm: 2, logLength: 9 },
        { term: 6, success: false, conflictIndex: 0, logLength: 0 },
        { term: 5, success: true, matchIndex: -1, logLength: 0, reason: 'extra fields survive' },
    ];
    for (const data of cases) {
        const { type, value } = roundTrip(encodeResponse(TYPES.APPEND_ENTRIES, data, 9));
        assert.equal(type, TYPES.APPEND_ENTRIES_RESPONSE);
        assert.deepEqual(value, data);
        assert.equal('conflictTerm' in value, 'conflictTerm' in data);
    }
});

test('votes, pre-votes and errors travel as JSON frames', () => {
    const vote = { term: 4, candidateId: 'replica2', lastLogIndex: 10, lastLogTerm: 3, force: false };
    assert.deepEqual(roundTrip(encodeRequest(TYPES.REQUEST_VOTE, vote, 2)).value, vote);
    const reply = { term: 4, voteGranted: false, reason: 'a leader is still alive' };
    assert.deepEqual(roundTrip(encodeResponse(TYPES.REQUEST_VOTE, reply, 2)).value, reply);
    const pre = { term: 5, candidateId: 'r3', candidateUrl: 'http://r3', lastLogIndex: 1, lastLogTerm: 1 };
    assert.equal(roundTrip(encodeRequest(TYPES.PRE_VOTE, pre, 3)).type, TYPES.PRE_VOTE);
    assert.equal(roundTrip(encodeResponse(TYPES.PRE_VOTE, { term: 4, preVoteGranted: true }, 3)).type, TYPES.PRE_VOTE_RESPONSE);
    assert.deepEqual(roundTrip(encodeError('boom', 7)).value, { message: 'boom' });
});

test('the decoder reassembles frames split at every byte and packed several per chunk', () => {
    const frames = [
        encodeRequest(TYPES.APPEND_ENTRIES, { term: 1, leaderId: 'l', leaderUrl: 'u', prevLogIndex: 0, prevLogTerm: 1, entries: ENTRIES.slice(0, 3), leaderCommit: 0 }, 1),
        encodeResponse(TYPES.APPEND_ENTRIES, { term: 1, success: true, matchIndex: 3 }, 1),
        encodeRequest(TYPES.REQUEST_VOTE, { term: 2, candidateId: 'x', lastLogIndex: 3, lastLogTerm: 1 }, 2),
    ];
    const stream = Buffer.concat(frames);
    for (const chunkSize of [1, 2, 7, 13, stream.length]) {
        const decoder = new FrameDecoder();
        const out = [];
        for (let i = 0; i < stream.length; i += chunkSize) out.push(...decoder.push(stream.subarray(i, i + chunkSize)));
        assert.deepEqual(out.map((f) => f.streamId), [1, 1, 2], `chunk size ${chunkSize}`);
        assert.equal(decoder.buffer.length, 0);
    }
});

test('the decoder rejects a foreign protocol version and an oversized frame', () => {
    const frame = encodeRequest(TYPES.REQUEST_VOTE, { term: 1 }, 1);
    const wrongVersion = Buffer.from(frame);
    wrongVersion.writeUInt8(VERSION + 1, 4);
    assert.throws(() => new FrameDecoder().push(wrongVersion), CodecError);
    const huge = Buffer.alloc(HEADER_BYTES);
    huge.writeUInt32BE(0xfffffff0, 0);
    huge.writeUInt8(VERSION, 4);
    assert.throws(() => new FrameDecoder({ maxFrameBytes: 1024 }).push(huge), /exceeds/);
});

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('requests multiplex on one connection and out-of-order replies reach their callers', async () => {
    const release = [];
    const server = createFramedTcpServer({
        handlers: {
            [TYPES.APPEND_ENTRIES]: (body) => new Promise((resolve) => {
                release.push(() => resolve({ term: body.term, success: true, matchIndex: body.prevLogIndex + body.entries.length }));
            }),
        },
    });
    const port = await listen(server);
    const opened = [];
    const transport = new FramedTcpTransport({ portOffset: 0, onSocket: (s) => opened.push(s) });
    const url = `http://127.0.0.1:${port}/append-entries`;
    const first = transport.post(url, { term: 1, leaderId: 'l', leaderUrl: null, prevLogIndex: -1, prevLogTerm: 0, entries: ENTRIES.slice(0, 1), leaderCommit: -1 });
    const second = transport.post(url, { term: 1, leaderId: 'l', leaderUrl: null, prevLogIndex: 0, prevLogTerm: 3, entries: ENTRIES.slice(1, 3), leaderCommit: -1 });
    while (release.length < 2) await new Promise((r) => setTimeout(r, 5));
    release[1](); // answer the second first
    release[0]();
    assert.equal((await second).data.matchIndex, 2);
    assert.equal((await first).data.matchIndex, 0);
    assert.equal(opened.length, 1, 'both requests used one connection');
    transport.close();
    server.close();
});

test('a request with no answer times out, and a dead peer is reported, not hung', async () => {
    const server = createFramedTcpServer({ handlers: { [TYPES.PRE_VOTE]: () => new Promise(() => {}) } });
    const port = await listen(server);
    const transport = new FramedTcpTransport({ portOffset: 0 });
    await assert.rejects(transport.post(`http://127.0.0.1:${port}/pre-vote`, { term: 1 }, { timeout: 50 }), { code: 'ETIMEDOUT' });
    server.close();
    transport.close();
    await assert.rejects(transport.post(`http://127.0.0.1:${port}/pre-vote`, { term: 1 }, { timeout: 500 }), (error) => error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET');
});

test('the transport reconnects when a peer comes back', async () => {
    const node = new RaftNode({ replicaId: 'f', nodeUrl: 'http://f', members: ['http://l', 'http://f'], storagePath: false, autoStart: false });
    let server = createFramedTcpServer({ handlers: raftHandlers(node) });
    const port = await listen(server);
    const transport = new FramedTcpTransport({ portOffset: 0 });
    const url = `http://127.0.0.1:${port}/append-entries`;
    const heartbeat = { term: 1, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: -1, prevLogTerm: 0, entries: [], leaderCommit: -1 };
    const log = console.log;
    console.log = () => {};
    try {
        assert.equal((await transport.post(url, heartbeat)).data.success, true);
        // The peer goes away: its connection drops, then its listener.
        for (const connection of transport.connections.values()) connection.close();
        await new Promise((resolve) => server.close(resolve));
        server = createFramedTcpServer({ handlers: raftHandlers(node) });
        await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
        assert.equal((await transport.post(url, heartbeat)).data.success, true);
    } finally {
        console.log = log;
        transport.close();
        server.close();
        node.stop();
    }
});

test('a real RaftNode behind the framed transport accepts entries exactly as over HTTP', async () => {
    const log = console.log;
    console.log = () => {};
    const follower = new RaftNode({ replicaId: 'f', nodeUrl: 'http://f', members: ['http://l', 'http://f', 'http://g'], storagePath: false, autoStart: false });
    const server = createFramedTcpServer({ handlers: raftHandlers(follower) });
    const port = await listen(server);
    const transport = new FramedTcpTransport({ portOffset: 0 });
    try {
        const response = await transport.post(`http://127.0.0.1:${port}/append-entries`, {
            term: 3, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: -1, prevLogTerm: 0,
            entries: ENTRIES.slice(0, 4).map((e, i) => ({ ...e, index: i })), leaderCommit: 1,
        });
        assert.deepEqual(response.data, { term: 3, success: true, matchIndex: 3, logLength: 4 });
        assert.equal(follower.commitIndex, 1);
        assert.equal(follower.stateMachine.get('k').value, 'v');
        assert.deepEqual(follower.configuration.members, ['a', 'b']);
    } finally {
        console.log = log;
        transport.close();
        server.close();
        follower.stop();
    }
});
