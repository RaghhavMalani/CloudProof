'use strict';

/**
 * multi-raft-cluster.js — several Raft groups on the same simulated nodes,
 * under one virtual clock and one network (CLOUDPROOF-PHASE-IV-B.md IV-B.0).
 *
 * Every range replica is the real, unchanged RaftNode with a RangeStateMachine,
 * hosted by the real MultiRaftNode; only the clock and the network are
 * substituted, as in sim/cluster.js. A node is a simulated process: crashing
 * it takes down every range replica it hosts at once (the correlated failure
 * a single-group simulation never produces), while crashGroup() takes down one
 * range replica and leaves the node's other ranges serving.
 *
 * Deterministic from the seed: the network, every group's election jitter and
 * every scheduling decision come from seeded generators.
 */

const { VirtualClock, SimNetwork, Rng } = require('./simulator');
const { MemoryStableStore, MemoryLogStore } = require('./cluster');
const { HistoryRecorder } = require('./linearizability');
const { MultiRaftNode } = require('../packages/multi-raft/multi-raft-node');
const { RangeDirectory, staticDescriptors, checkDescriptors } = require('../packages/multi-raft/descriptors');
const { RangeRouter, ClientSession, logicalRequestId } = require('../packages/multi-raft/router');
const { PROFILES } = require('../replica/raft-profiles');

function engineProfile(name) {
    const profile = PROFILES[name];
    if (!profile) throw new Error(`unknown raft profile ${name}`);
    if (profile.wire) throw new Error(`IV-B.0 is HTTP-only; profile ${name} selects ${profile.wire}`);
    return { ...profile };
}

class SimMultiRaftCluster {
    constructor({
        nodes = 3,
        boundaries = ['h', 'p'],
        seed = 1,
        profile = 'baseline',
        dropRate = 0,
        minLatency = 2,
        maxLatency = 25,
        electionTimeoutMin = 150,
        electionTimeoutMax = 300,
        heartbeatInterval = 40,
        commitTimeoutMs = 1500,
    } = {}) {
        this.seed = seed;
        this.profile = profile;
        this.clock = new VirtualClock();
        this.network = new SimNetwork(this.clock, new Rng((seed * 2654435761) >>> 0), { dropRate, minLatency, maxLatency });
        this.nodeIds = Array.from({ length: nodes }, (_, i) => `n${i + 1}`);
        this.origins = this.nodeIds.map((_, i) => `http://node${i}:5000`);
        this.directory = new RangeDirectory(staticDescriptors({ boundaries, replicas: this.nodeIds }));
        this.rangeIds = this.directory.all().map((d) => d.rangeId);
        this.raftOptions = {
            ...engineProfile(profile), electionTimeoutMin, electionTimeoutMax, heartbeatInterval, commitTimeoutMs,
        };
        this.stores = new Map();
        this.jitter = new Map();
        this.nodes = this.nodeIds.map(() => null);
        for (let i = 0; i < nodes; i += 1) this._spawn(i);
    }

    _store(nodeId, rangeId) {
        const key = `${nodeId}:${rangeId}`;
        if (!this.stores.has(key)) this.stores.set(key, { stableStore: new MemoryStableStore(), logStore: new MemoryLogStore() });
        return this.stores.get(key);
    }

    /** One generator per (node, range), created once, so restarts continue the same sequence. */
    _jitterFor(index, rangeId) {
        const key = `${index}:${rangeId}`;
        const position = this.rangeIds.indexOf(rangeId);
        if (!this.jitter.has(key)) {
            this.jitter.set(key, new Rng((this.seed * 7919 + index * 104729 + position * 1299709 + 17) >>> 0));
        }
        const rng = this.jitter.get(key);
        // A fixed per-replica offset as in sim/cluster.js, so replicas do not time out in lockstep.
        const offset = (index * 13 + position * 7) % 40;
        return (min, max) => rng.range(min, Math.max(min, max - 1)) + offset;
    }

    _spawn(index) {
        const nodeId = this.nodeIds[index];
        const origin = this.origins[index];
        const node = new MultiRaftNode({
            nodeId,
            origin,
            memberOrigins: this.origins,
            directory: this.directory,
            transport: this.network.forNode(origin),
            storageFor: (rangeId) => ({ ...this._store(nodeId, rangeId), storagePath: false }),
            raftOptions: this.raftOptions,
            groupOptions: (rangeId) => ({ clock: this.clock, randomElectionTimeout: this._jitterFor(index, rangeId) }),
        });
        this.network.register(origin, node.handlers());
        this.nodes[index] = node;
        return node;
    }

    isUp(index) { return this.nodes[index] !== null; }

    /** The leader a client should use for a range: the highest-term live claimant. */
    leaderOf(rangeId) {
        let best = null;
        this.nodes.forEach((node, index) => {
            if (!node) return;
            const group = node.groups.get(rangeId);
            if (!group || group.crashed || !group.raft.isLeader()) return;
            if (!best || group.raft.currentTerm > best.group.raft.currentTerm) best = { index, node, group };
        });
        return best;
    }

    tick(ms) { return this.clock.runFor(ms); }

    sleep(ms) { return new Promise((resolve) => this.clock.setTimeout(resolve, ms)); }

    /** Resolves with `fallback` if `promise` has not settled within `ms` of virtual time. */
    within(promise, ms, fallback) {
        return Promise.race([promise, this.sleep(ms).then(() => fallback)]);
    }

    // ── faults ───────────────────────────────────────────────────────────────

    crashNode(index) {
        const node = this.nodes[index];
        if (!node) return false;
        node.stop();
        for (const rangeId of this.rangeIds) this._store(this.nodeIds[index], rangeId).logStore.dropPending();
        this.network.crash(this.origins[index]);
        this.nodes[index] = null;
        return true;
    }

    restartNode(index) {
        if (this.nodes[index]) return false;
        this.network.restart(this.origins[index]);
        this._spawn(index);
        return true;
    }

    crashGroup(index, rangeId) { return this.nodes[index] ? this.nodes[index].crashGroup(rangeId) : false; }

    restartGroup(index, rangeId) { return this.nodes[index] ? this.nodes[index].restartGroup(rangeId) : false; }

    partition(groupsOfIndexes) { this.network.partition(groupsOfIndexes.map((g) => g.map((i) => this.origins[i]))); }

    heal() { this.network.heal(); }

    /** Heals, stops packet loss and brings every node and range replica back. */
    recoverAll() {
        this.heal();
        this.network.dropRate = 0;
        this.nodes.forEach((node, index) => {
            if (!node) { this.restartNode(index); return; }
            for (const rangeId of this.rangeIds) if (node.groups.get(rangeId).crashed) node.restartGroup(rangeId);
        });
    }

    // ── evidence ─────────────────────────────────────────────────────────────

    replicaLedgers() {
        const out = [];
        this.nodes.forEach((node) => {
            if (!node) return;
            for (const rangeId of this.rangeIds) {
                const ledger = node.ledger(rangeId);
                if (ledger) out.push({ rangeId, nodeId: node.nodeId, ledger });
            }
        });
        return out;
    }

    /**
     * Raft's own safety properties, checked per range on the live replicas:
     * Log Matching, and identical committed prefixes (State Machine Safety).
     */
    checkRanges() {
        const problems = [];
        for (const rangeId of this.rangeIds) {
            const live = this.nodes.filter(Boolean).map((n) => n.groups.get(rangeId)).filter((g) => g && !g.crashed);
            for (let i = 0; i < live.length; i += 1) {
                for (let j = i + 1; j < live.length; j += 1) {
                    const a = live[i].raft.log;
                    const b = live[j].raft.log;
                    let deepest = -1;
                    for (let k = Math.min(a.length, b.length) - 1; k >= 0; k -= 1) {
                        if (a[k].term === b[k].term) { deepest = k; break; }
                    }
                    for (let k = 0; k <= deepest; k += 1) {
                        if (a[k].term !== b[k].term || JSON.stringify(a[k].data) !== JSON.stringify(b[k].data)) {
                            problems.push(`${rangeId}: log matching violated at ${k}`);
                            break;
                        }
                    }
                }
            }
            if (live.length) {
                const minCommit = Math.min(...live.map((g) => g.raft.commitIndex));
                for (let k = 0; k <= minCommit; k += 1) {
                    const reference = JSON.stringify(live[0].raft.log[k] && live[0].raft.log[k].data);
                    if (live.some((g) => JSON.stringify(g.raft.log[k] && g.raft.log[k].data) !== reference)) {
                        problems.push(`${rangeId}: committed entry ${k} differs across replicas`);
                        break;
                    }
                }
            }
        }
        const descriptors = checkDescriptors(this.directory.all());
        return { ok: problems.length === 0 && descriptors.ok, problems: [...problems, ...descriptors.violations] };
    }

    /**
     * Whether every live replica of every range has applied the same log
     * position and holds the same state. Equal state alone is not enough: an
     * entry rejected at apply changes no state, so a replica could look
     * converged while its ledger still lacks the rejection.
     */
    converged() {
        return this.rangeIds.every((rangeId) => {
            const groups = this.nodes.filter(Boolean).map((n) => n.groups.get(rangeId)).filter((g) => g && !g.crashed);
            if (!groups.length) return false;
            const states = new Set(groups.map((g) => JSON.stringify(g.stateMachine.list())));
            const applied = new Set(groups.map((g) => g.raft.lastApplied));
            const commit = Math.max(...groups.map((g) => g.raft.commitIndex));
            return states.size === 1 && applied.size === 1 && groups[0].raft.lastApplied === commit;
        });
    }

    stop() { for (const node of this.nodes) if (node) node.stop(); }
}

/**
 * A logical client over the router. One operation at a time per process; a
 * write is retried under the same LogicalRequestId until it is acknowledged,
 * definitely rejected, or its deadline passes. The history records the logical
 * operation, not the attempts: invoke at the first attempt, completion at the
 * end. "fail" is used only when no attempt can have applied (every attempt was
 * refused before append); otherwise an unacknowledged write is "info".
 */
class SimRangeClient {
    constructor({
        cluster, history, clientId, process, retryDelayMs = 25, deadlineMs = 4000, attemptTimeoutMs = 2500,
        // A shorter wait for the first attempt only: the client gives up on a
        // write that is still in flight and retries it under the same
        // LogicalRequestId, which is what exercises deduplication.
        firstAttemptTimeoutMs = null,
    }) {
        this.cluster = cluster;
        this.history = history;
        this.router = new RangeRouter({ directory: cluster.directory });
        this.session = new ClientSession(clientId);
        this.process = process;
        this.retryDelayMs = retryDelayMs;
        this.deadlineMs = deadlineMs;
        this.attemptTimeoutMs = attemptTimeoutMs;
        this.firstAttemptTimeoutMs = firstAttemptTimeoutMs;
        this.requests = [];
    }

    async write(key, value, op = 'set') {
        const { cluster, history } = this;
        const id = this.session.next();
        const record = {
            logicalRequestId: logicalRequestId(id), key, op, value, attempts: [], acknowledged: false, resultReturned: null,
            invokedAt: cluster.clock.now(), completedAt: null,
        };
        this.requests.push(record);
        history.invoke(this.process, op === 'delete' ? { kind: 'delete', key } : { kind: 'write', key, value });
        const deadline = cluster.clock.now() + this.deadlineMs;
        let mayHaveApplied = false;
        for (;;) {
            const request = this.router.request({ ...id, op, key, value });
            const leader = cluster.leaderOf(request.rangeId);
            const timeout = record.attempts.length === 0 && this.firstAttemptTimeoutMs ? this.firstAttemptTimeoutMs : this.attemptTimeoutMs;
            const outcome = leader
                ? await cluster.within(leader.node.write(request), timeout, { status: 'UNKNOWN', reason: 'attempt timed out' })
                : { status: 'NO_LEADER' };
            record.attempts.push({
                rangeId: request.rangeId, epoch: request.expectedRangeEpoch, status: outcome.status,
                duplicate: Boolean(outcome.duplicate), at: cluster.clock.now(),
            });
            if (outcome.status === 'OK') {
                record.acknowledged = true;
                record.resultReturned = outcome.result;
                record.completedAt = cluster.clock.now();
                history.ok(this.process, true);
                return record;
            }
            if (outcome.status === 'UNKNOWN') mayHaveApplied = true;
            if (outcome.status === 'STALE_RANGE_EPOCH' || cluster.clock.now() >= deadline) {
                record.completedAt = cluster.clock.now();
                if (mayHaveApplied) history.info(this.process); else history.fail(this.process);
                return record;
            }
            await cluster.sleep(this.retryDelayMs);
        }
    }

    async read(key) {
        const { cluster, history } = this;
        history.invoke(this.process, { kind: 'read', key });
        const deadline = cluster.clock.now() + this.deadlineMs;
        for (;;) {
            const { rangeId, expectedRangeEpoch } = this.router.route(key);
            const leader = cluster.leaderOf(rangeId);
            const outcome = leader
                ? await cluster.within(leader.node.read({ rangeId, expectedRangeEpoch, key }), this.attemptTimeoutMs, { status: 'UNKNOWN' })
                : { status: 'NO_LEADER' };
            if (outcome.status === 'OK') { history.ok(this.process, outcome.value); return outcome.value; }
            // A read has no effect, so an unanswered read constrains nothing.
            if (cluster.clock.now() >= deadline) { history.fail(this.process); return undefined; }
            await cluster.sleep(this.retryDelayMs);
        }
    }
}

module.exports = { SimMultiRaftCluster, SimRangeClient, HistoryRecorder, engineProfile };
