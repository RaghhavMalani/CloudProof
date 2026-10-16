'use strict';

/**
 * multi-raft-node.js — one process hosting replicas of several ranges
 * (CLOUDPROOF-PHASE-IV-B.md §2.2, IV-B.0).
 *
 * Each range is a RangeGroup: an ordinary, unchanged Phase IV-A RaftNode with
 * its own RangeStateMachine, log and stable storage. What makes several of them
 * share a process is only addressing: a group's member URLs carry the range,
 *
 *     http://node1:5001/ranges/r1        (nodeUrl of r1 on node1)
 *     POST http://node1:5001/ranges/r1/append-entries
 *
 * so the engine's own `${peerUrl}/append-entries` requests reach the right
 * group, and one listener per process dispatches on `/ranges/<rangeId>/...`.
 * The groups share the process's event loop and nothing else.
 *
 * Transport-agnostic: the simulator registers handlers() on its SimNetwork,
 * and http-server.js serves the same object over HTTP. The transport handed in
 * must be bound to this node's ORIGIN, not to a group URL: the simulator's
 * partitions are keyed by origin, and a group URL would slip through them.
 *
 * Client writes return one of:
 *   OK                  committed; `result` is the state machine's result
 *   STALE_RANGE_EPOCH   rejected at admission or at apply; definitely not applied
 *   NOT_LEADER          not applied; `leaderHint` is the origin to try
 *   UNKNOWN             the commit wait ended without a verdict; may or may not apply
 *   UNAVAILABLE         this replica of the range is down; not applied
 */

const { RaftNode } = require('../../replica/raft');
const { RangeStateMachine, addressVerdict, fenceVerdict, staleRangeEpoch, STALE_RANGE_EPOCH } = require('./range-state-machine');

const RPC_HANDLERS = Object.freeze({
    'append-entries': 'handleAppendEntries',
    'request-vote': 'handleRequestVote',
    'pre-vote': 'handlePreVote',
});

const groupUrl = (origin, rangeId) => `${origin}/ranges/${rangeId}`;

function originOf(url) {
    if (!url) return null;
    try { return new URL(url).origin; } catch (_) { return null; }
}

class MultiRaftNode {
    constructor({
        nodeId,
        origin,
        memberOrigins,
        directory,
        transport,
        // rangeId -> engine storage options ({ stableStore, logStore, storagePath: false } or { storagePath })
        storageFor,
        // Engine options for every group (a raft-profiles.js profile, timing).
        raftOptions = {},
        // rangeId -> per-group engine options (clock, seeded election jitter).
        groupOptions = () => ({}),
    }) {
        if (!origin || !memberOrigins || !memberOrigins.includes(origin)) {
            throw new Error('MultiRaftNode requires its origin to be one of memberOrigins');
        }
        this.nodeId = nodeId;
        this.origin = origin;
        this.memberOrigins = [...memberOrigins];
        this.directory = directory;
        this.transport = transport;
        this.storageFor = storageFor;
        this.raftOptions = raftOptions;
        this.groupOptions = groupOptions;
        this.groups = new Map();
        for (const descriptor of directory.all()) {
            if (descriptor.replicas.includes(nodeId)) this._startGroup(descriptor);
        }
    }

    _startGroup(descriptor) {
        const { rangeId } = descriptor;
        const storage = this.storageFor(rangeId);
        const stateMachine = new RangeStateMachine({ descriptor });
        const raft = new RaftNode({
            replicaId: `${this.nodeId}:${rangeId}`,
            nodeUrl: groupUrl(this.origin, rangeId),
            members: this.memberOrigins.map((origin) => groupUrl(origin, rangeId)),
            transport: this.transport,
            stateMachine,
            ...storage,
            ...this.raftOptions,
            ...this.groupOptions(rangeId),
        });
        const group = { rangeId, descriptor, raft, stateMachine, storage, crashed: false };
        this.groups.set(rangeId, group);
        return group;
    }

    /** RPC routes for every hosted group: `/ranges/<rangeId>/<rpc>` -> handler. */
    handlers() {
        const routes = {};
        for (const rangeId of this.groups.keys()) {
            for (const rpc of Object.keys(RPC_HANDLERS)) {
                routes[`/ranges/${rangeId}/${rpc}`] = (body) => this.rpc(rangeId, rpc, body);
            }
        }
        return routes;
    }

    /** Dispatches one Raft RPC to its group. A crashed group refuses it. */
    rpc(rangeId, rpc, body) {
        const group = this.groups.get(rangeId);
        const method = RPC_HANDLERS[rpc];
        if (!group || !method) throw Object.assign(new Error(`no route ${rangeId}/${rpc}`), { code: 'ENOENT' });
        if (group.crashed) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
        return group.raft[method](body);
    }

    _hostedGroup(rangeId) {
        const group = this.groups.get(rangeId);
        if (!group) {
            return { error: { status: STALE_RANGE_EPOCH, ...staleRangeEpoch(null, `range ${rangeId} is not hosted on ${this.nodeId}`), at: 'admission' } };
        }
        if (group.crashed) return { error: { status: 'UNAVAILABLE', reason: `${this.nodeId}:${rangeId} is down` } };
        return { group };
    }

    _notLeader(group) {
        return { status: 'NOT_LEADER', leaderHint: originOf(group.raft.leaderUrl) };
    }

    /** One routed client write: { rangeId, expectedRangeEpoch, clientId, seqNo, key, op, value, ... }. */
    async write(request) {
        const { group, error } = this._hostedGroup(request && request.rangeId);
        if (error) return error;
        // Admission: a fast reject only. The authoritative check runs at apply.
        const verdict = fenceVerdict(group.descriptor, request);
        if (!verdict.ok) return { status: STALE_RANGE_EPOCH, ...staleRangeEpoch(group.descriptor, verdict.reason), at: 'admission' };
        if (!group.raft.isLeader()) return this._notLeader(group);
        const data = {
            op: request.op,
            key: request.key,
            clientId: request.clientId,
            seqNo: request.seqNo,
            rangeId: request.rangeId,
            expectedRangeEpoch: request.expectedRangeEpoch,
        };
        if (request.op === 'set' || request.op === 'cas') data.value = request.value ?? null;
        if (request.op === 'cas') {
            if (request.expectRev !== undefined) data.expectRev = request.expectRev;
            if (request.expect !== undefined) data.expect = request.expect;
        }
        let outcome;
        try {
            outcome = await group.raft.clientAppend(data);
        } catch (err) {
            // Thrown before anything is appended: definitely not applied.
            if (/Not the leader/.test(err.message)) return this._notLeader(group);
            throw err;
        }
        if (!outcome.committed) return { status: 'UNKNOWN', reason: 'the commit wait ended without a verdict' };
        const result = outcome.result;
        if (result && result.error === STALE_RANGE_EPOCH) return { status: STALE_RANGE_EPOCH, ...result, at: 'apply' };
        return { status: 'OK', index: outcome.entry ? outcome.entry.index : null, duplicate: Boolean(outcome.duplicate), result };
    }

    /** A linearizable (ReadIndex) read of one key, behind the same address fence. */
    async read({ rangeId, expectedRangeEpoch, key }) {
        const { group, error } = this._hostedGroup(rangeId);
        if (error) return error;
        const verdict = addressVerdict(group.descriptor, { rangeId, expectedRangeEpoch, key });
        if (!verdict.ok) return { status: STALE_RANGE_EPOCH, ...staleRangeEpoch(group.descriptor, verdict.reason), at: 'admission' };
        if (!group.raft.isLeader()) return this._notLeader(group);
        try {
            const record = await group.raft.readLinearizable((sm) => sm.get(key));
            return { status: 'OK', value: record ? record.value : null };
        } catch (err) {
            if (/Not the leader/.test(err.message)) return this._notLeader(group);
            return { status: 'UNAVAILABLE', reason: err.message };
        }
    }

    /**
     * Crashes one range's replica on this node, as a process crash would:
     * timers stop, memory is gone, durable storage stays, and anything
     * buffered but not yet flushed is lost. Other ranges are untouched.
     */
    crashGroup(rangeId) {
        const group = this.groups.get(rangeId);
        if (!group || group.crashed) return false;
        group.raft.stop();
        if (group.storage.logStore && typeof group.storage.logStore.dropPending === 'function') group.storage.logStore.dropPending();
        group.crashed = true;
        return true;
    }

    /** Restarts a crashed group from its durable storage only. */
    restartGroup(rangeId) {
        const group = this.groups.get(rangeId);
        if (!group || !group.crashed) return false;
        this._startGroup(group.descriptor);
        return true;
    }

    stop() {
        for (const group of this.groups.values()) if (!group.crashed) group.raft.stop();
    }

    status() {
        return [...this.groups.values()].map((g) => ({
            rangeId: g.rangeId,
            epoch: g.descriptor.epoch,
            crashed: g.crashed,
            state: g.crashed ? null : g.raft.state,
            leader: !g.crashed && g.raft.isLeader(),
            term: g.crashed ? null : g.raft.currentTerm,
            leaderOrigin: g.crashed ? null : originOf(g.raft.leaderUrl),
            commitIndex: g.crashed ? null : g.raft.commitIndex,
            lastApplied: g.crashed ? null : g.raft.lastApplied,
            logLength: g.crashed ? null : g.raft.log.length,
        }));
    }

    /** The range's application ledger on this replica (§5.2). */
    ledger(rangeId) {
        const group = this.groups.get(rangeId);
        return group && !group.crashed ? group.stateMachine.ledger.map((row) => ({ ...row })) : null;
    }

    /** The range's applied key-value state on this replica. */
    state(rangeId) {
        const group = this.groups.get(rangeId);
        if (!group || group.crashed) return null;
        return Object.fromEntries(group.stateMachine.list().map((record) => [record.key, record.value]));
    }
}

module.exports = { MultiRaftNode, groupUrl, originOf, RPC_HANDLERS };
