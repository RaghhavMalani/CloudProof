'use strict';

/**
 * perf-mutants.js — deliberately broken versions of the Phase IV-A
 * optimizations, used only to prove the targeted fault campaign can see the
 * bugs it exists to catch. Each mutant patches one RaftNode method and returns
 * a function that restores it. Nothing here is loaded by the replica.
 */

const { RaftNode } = require('../replica/raft');

const MUTANTS = {
    // Follower acknowledges before its append is durable.
    'ack-before-durable': () => {
        const original = RaftNode.prototype._acknowledgeWhenDurable;
        RaftNode.prototype._acknowledgeWhenDurable = function ackEarly(response) { return Promise.resolve(response); };
        return () => { RaftNode.prototype._acknowledgeWhenDurable = original; };
    },
    // Follower waits for durability but never re-validates the term/epoch.
    'ack-not-revoked': () => {
        const original = RaftNode.prototype._acknowledgeWhenDurable;
        RaftNode.prototype._acknowledgeWhenDurable = function ackUnchecked(response) {
            return new Promise((resolve) => {
                this._durableWaiters.push({
                    need: response.matchIndex + 1,
                    term: this.currentTerm,
                    epoch: this._logEpoch,
                    release: () => resolve(response),
                });
            });
        };
        return () => { RaftNode.prototype._acknowledgeWhenDurable = original; };
    },
    // Leader counts its own copy toward a majority before it is durable.
    'leader-counts-volatile-copy': () => {
        const original = RaftNode.prototype._advanceCommitIndex;
        RaftNode.prototype._advanceCommitIndex = function advanceUnsafe() {
            const saved = this._groupCommit;
            this._groupCommit = null; // selfDurable becomes unconditionally true
            try { return original.call(this); } finally { this._groupCommit = saved; }
        };
        return () => { RaftNode.prototype._advanceCommitIndex = original; };
    },
    // Pipelining without the leadership-epoch fence: a reply to a request sent
    // under an earlier leadership (or term) updates the current one.
    'pipeline-no-epoch-fence': () => {
        const original = RaftNode.prototype._onAppendResponse;
        RaftNode.prototype._onAppendResponse = function unfenced(peerUrl, request, _epoch, _term, data) {
            return original.call(this, peerUrl, request, this._leaderEpoch, this.currentTerm, data);
        };
        return () => { RaftNode.prototype._onAppendResponse = original; };
    },
    // Pipelining that counts what it has *sent* as matched.
    'pipeline-optimistic-match': () => {
        const original = RaftNode.prototype._sendAppend;
        RaftNode.prototype._sendAppend = function optimistic(peerUrl, progress, next, count) {
            original.call(this, peerUrl, progress, next, count);
            const last = next + count - 1;
            if (progress.mode === 'replicate' && last > (this.matchIndex[peerUrl] ?? -1)) {
                this.matchIndex[peerUrl] = last;
                this._advanceCommitIndex();
            }
        };
        return () => { RaftNode.prototype._sendAppend = original; };
    },
};

function applyMutant(name) {
    const mutant = MUTANTS[name];
    if (!mutant) throw new Error(`unknown mutant ${name}`);
    return mutant();
}

// ── killers: small, direct checks that each must pass on the real engine ────

const { STATES } = require('../replica/raft');
const { MemoryStableStore, MemoryLogStore } = require('./cluster');
const { runPerfFault } = require('./perf-faults');

const MANUAL_FLUSH = { maxEntries: 1024, maxDelayMs: 60000, metaIntervalMs: 60000 };
const turn = () => new Promise((resolve) => setImmediate(resolve));
const entry = (term, index, value = index) => ({ term, index, ts: 1, data: { op: 'set', key: `k${index}`, value } });

function follower() {
    return new RaftNode({
        replicaId: 'f1', nodeUrl: 'http://f1', members: ['http://l', 'http://f1', 'http://f2'],
        stableStore: new MemoryStableStore(), logStore: new MemoryLogStore(), storagePath: false,
        autoStart: false, groupCommit: MANUAL_FLUSH,
    });
}

const KILLERS = {
    /** A follower's ack must not exist before its flush. */
    async 'follower-ack-waits-for-flush'() {
        const node = follower();
        const response = node.handleAppendEntries({
            term: 1, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: -1, prevLogTerm: 0,
            entries: [entry(1, 0)], leaderCommit: -1,
        });
        let settled = false;
        Promise.resolve(response).then(() => { settled = true; });
        await turn();
        node.stop();
        return settled ? { ok: false, reason: 'acknowledged before durable' } : { ok: true };
    },

    /** An ack prepared before a term change and truncation must be revoked. */
    async 'stale-ack-is-revoked'() {
        const node = follower();
        const stale = node.handleAppendEntries({
            term: 2, leaderId: 'old', leaderUrl: 'http://old', prevLogIndex: -1, prevLogTerm: 0,
            entries: [entry(2, 0), entry(2, 1)], leaderCommit: -1,
        });
        node.handleAppendEntries({
            term: 3, leaderId: 'l', leaderUrl: 'http://l', prevLogIndex: 0, prevLogTerm: 2,
            entries: [entry(3, 1, 'new')], leaderCommit: -1,
        });
        node.flushDurable();
        const sent = await stale;
        node.stop();
        return sent.success ? { ok: false, reason: 'a superseded ack was sent as success' } : { ok: true };
    },

    /** Leader + one follower is a majority only once the leader's copy is durable. */
    async 'leader-waits-for-own-durability'() {
        const node = new RaftNode({
            replicaId: 'l', nodeUrl: 'http://l', members: ['http://l', 'http://f1', 'http://f2'],
            stableStore: new MemoryStableStore(), logStore: new MemoryLogStore(), storagePath: false,
            autoStart: false, groupCommit: MANUAL_FLUSH, commitTimeoutMs: 5000,
            transport: {
                post: (url, body) => (url.startsWith('http://f2')
                    ? new Promise(() => {})
                    : Promise.resolve({ data: { term: body.term, success: true, matchIndex: body.prevLogIndex + body.entries.length } })),
            },
        });
        node.state = STATES.CANDIDATE;
        node.currentTerm = 1;
        node._becomeLeader();
        node._stopHeartbeat();
        await turn();
        void node.clientAppend({ op: 'set', key: 'a', value: 1 });
        await turn();
        await turn();
        const committedEarly = node.commitIndex >= 0;
        node.stop();
        return committedEarly ? { ok: false, reason: 'committed on a volatile leader copy' } : { ok: true };
    },

    /** A reply from an earlier leadership must not move this one's progress. */
    async 'stale-reply-fenced'() {
        const pending = [];
        const transport = { post: (url, body) => new Promise((resolve) => pending.push({ url, body, resolve })) };
        const node = new RaftNode({
            replicaId: 'l', nodeUrl: 'http://l', members: ['http://l', 'http://a', 'http://b'],
            stableStore: new MemoryStableStore(), logStore: new MemoryLogStore(), storagePath: false,
            autoStart: false, transport, pipeline: { maxInflight: 4 }, commitTimeoutMs: 60000,
        });
        node.state = STATES.CANDIDATE;
        node.currentTerm = 1;
        node._becomeLeader();
        node._stopHeartbeat();
        const old = pending.find((m) => m.url.startsWith('http://a'));
        node._becomeFollower(2);
        node.state = STATES.CANDIDATE;
        node.currentTerm = 3;
        node._becomeLeader();
        node._stopHeartbeat();
        old.resolve({ data: { term: 1, success: true, matchIndex: old.body.prevLogIndex + old.body.entries.length } });
        await turn();
        const moved = node.matchIndex['http://a'] !== -1;
        node.stop();
        return moved ? { ok: false, reason: 'a term-1 reply moved term-3 progress' } : { ok: true };
    },

    /** Pipelined sends must not count as acknowledgements. */
    async 'pipelined-send-is-not-an-ack'() {
        const pending = [];
        const transport = { post: (url, body) => new Promise((resolve) => pending.push({ url, body, resolve })) };
        const node = new RaftNode({
            replicaId: 'l', nodeUrl: 'http://l', members: ['http://l', 'http://a', 'http://b'],
            stableStore: new MemoryStableStore(), logStore: new MemoryLogStore(), storagePath: false,
            autoStart: false, transport, pipeline: { maxInflight: 4 }, commitTimeoutMs: 60000,
        });
        node.state = STATES.CANDIDATE;
        node.currentTerm = 1;
        node._becomeLeader();
        node._stopHeartbeat();
        for (const m of pending.splice(0)) {
            m.resolve({ data: { term: 1, success: true, matchIndex: m.body.prevLogIndex + m.body.entries.length } });
        }
        await turn();
        void node.clientAppend({ op: 'set', key: 'k', value: 1 });
        await turn();
        const committed = node.commitIndex >= 1;
        node.stop();
        return committed ? { ok: false, reason: 'committed an entry no follower acknowledged' } : { ok: true };
    },

    /** Correlated power loss: acknowledged writes must survive a full restart. */
    async 'power-loss-campaign'() {
        const log = console.log;
        console.log = () => {};
        try {
            const plan = [
                ['group-commit-delay', ['power-loss-lone-write', 'cluster-power-loss', 'power-loss-on-ack']],
                ['pipeline-delay', ['leader-crash-pipelined', 'power-loss-on-ack']],
            ];
            for (const [profile, scenarios] of plan) {
                for (const scenario of scenarios) {
                    for (let seed = 1; seed <= 30; seed += 1) {
                        const result = await runPerfFault({ seed, scenario, profile });
                        if (!result.ok) return { ok: false, reason: `${profile} ${scenario} seed ${seed}: ${result.failures[0]}` };
                    }
                }
            }
            return { ok: true };
        } finally {
            console.log = log;
        }
    },
};

module.exports = { MUTANTS, applyMutant, KILLERS };
