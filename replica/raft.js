/**
 * raft.js — a compact, defensible Raft consensus engine.
 *
 * Implements the safety-critical pieces used by the demo:
 *  - stable term / vote / log persistence before RPC responses
 *  - randomized elections with a dynamic majority
 *  - AppendEntries for both replication and heartbeats
 *  - nextIndex / matchIndex catch-up
 *  - the Raft §5.4.2 current-term commit rule
 *  - client request deduplication through clientId + seqNo
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STATES = {
    FOLLOWER: 'FOLLOWER',
    CANDIDATE: 'CANDIDATE',
    LEADER: 'LEADER',
};

class StableStateStore {
    constructor(filePath) {
        this.filePath = filePath;
    }

    load() {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            return JSON.parse(raw);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw new Error(`Unable to read Raft state at ${this.filePath}: ${error.message}`);
            }
            return {};
        }
    }

    save(state) {
        const directory = path.dirname(this.filePath);
        fs.mkdirSync(directory, { recursive: true });

        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        const descriptor = fs.openSync(temporaryPath, 'w', 0o600);
        try {
            fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }

        try {
            fs.renameSync(temporaryPath, this.filePath);
        } catch (error) {
            // Windows can reject replace-on-rename. The container path uses the
            // atomic branch above; this fallback keeps local development usable.
            if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
            fs.rmSync(this.filePath, { force: true });
            fs.renameSync(temporaryPath, this.filePath);
        }

        // fsyncing a directory is supported by Linux (the deployment target).
        try {
            const directoryDescriptor = fs.openSync(directory, 'r');
            try {
                fs.fsyncSync(directoryDescriptor);
            } finally {
                fs.closeSync(directoryDescriptor);
            }
        } catch (_) {
            // Some local filesystems do not permit opening a directory handle.
        }
    }
}

class RaftNode {
    constructor({
        replicaId,
        peers,
        nodeUrl = null,
        onCommit,
        onLeaderChange,
        storagePath,
        transport = axios,
        autoStart = true,
        electionTimeoutMin = 500,
        electionTimeoutMax = 800,
        heartbeatInterval = 150,
    }) {
        this.replicaId = replicaId;
        this.peers = [...peers];
        this.nodeUrl = nodeUrl;
        this.onCommit = onCommit;
        this.onLeaderChange = onLeaderChange;
        this.transport = transport;

        this.electionTimeoutMin = electionTimeoutMin;
        this.electionTimeoutMax = electionTimeoutMax;
        this.heartbeatInterval = heartbeatInterval;

        const defaultStoragePath = path.join(
            process.env.DATA_DIR || path.join(process.cwd(), 'data'),
            `${replicaId}.json`,
        );
        this.storagePath = storagePath == null ? defaultStoragePath : storagePath;
        this._store = this.storagePath === false ? null : new StableStateStore(this.storagePath);

        const stable = this._store ? this._store.load() : {};

        // Persistent state (§5.2). These values are written synchronously before
        // any RPC that depends on them is answered.
        this.currentTerm = Number.isInteger(stable.currentTerm) ? stable.currentTerm : 0;
        this.votedFor = typeof stable.votedFor === 'string' ? stable.votedFor : null;
        this.log = Array.isArray(stable.log) ? stable.log : [];

        // The paper classifies these as volatile. Persisting them here makes the
        // whiteboard replay cleanly after a full cluster restart.
        const storedCommit = Number.isInteger(stable.commitIndex) ? stable.commitIndex : -1;
        this.commitIndex = Math.min(storedCommit, this.log.length - 1);
        const storedApplied = Number.isInteger(stable.lastApplied)
            ? stable.lastApplied
            : this.commitIndex;
        this.lastApplied = Math.min(storedApplied, this.commitIndex);

        // Leader volatile state, keyed by peer URL.
        this.nextIndex = {};
        this.matchIndex = {};

        this.state = STATES.FOLLOWER;
        this.leaderId = null;
        this.leaderUrl = null;
        this.votes = 0;
        this.paused = false;

        this._timersEnabled = autoStart;
        this._electionTimer = null;
        this._heartbeatTimer = null;
        this._replicating = new Set();
        this.lastQuorumContactAt = 0;
        this.metrics = {
            electionsTotal: 0,
            commitLatencyCount: 0,
            commitLatencySumMs: 0,
            commitLatencyBuckets: { 10: 0, 25: 0, 50: 0, 100: 0, 250: 0, 500: 0, 1000: 0 },
        };

        if (autoStart) this._resetElectionTimer();

        console.log(
            `[${this.replicaId}] Raft node ready · term=${this.currentTerm} ` +
            `log=${this.log.length} commit=${this.commitIndex}`,
        );
    }

    get clusterSize() {
        return this.peers.length + 1;
    }

    get quorumSize() {
        return Math.floor(this.clusterSize / 2) + 1;
    }

    _persistentSnapshot() {
        return {
            version: 1,
            currentTerm: this.currentTerm,
            votedFor: this.votedFor,
            log: this.log,
            commitIndex: this.commitIndex,
            lastApplied: this.lastApplied,
        };
    }

    _persistState() {
        if (this._store) this._store.save(this._persistentSnapshot());
    }

    _randomTimeout() {
        const spread = Math.max(1, this.electionTimeoutMax - this.electionTimeoutMin);
        return Math.floor(Math.random() * spread) + this.electionTimeoutMin;
    }

    _resetElectionTimer() {
        if (this._electionTimer) clearTimeout(this._electionTimer);
        if (!this._timersEnabled || this.paused || this.state === STATES.LEADER) return;

        this._electionTimer = setTimeout(() => {
            this._startElection().catch((error) => {
                console.error(`[${this.replicaId}] Election failed: ${error.message}`);
                this._resetElectionTimer();
            });
        }, this._randomTimeout());
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        void this._replicateAll();
        this._heartbeatTimer = setInterval(
            () => void this._replicateAll(),
            this.heartbeatInterval,
        );
    }

    _stopHeartbeat() {
        if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
    }

    stop() {
        if (this._electionTimer) clearTimeout(this._electionTimer);
        this._electionTimer = null;
        this._stopHeartbeat();
    }

    pause() {
        if (this.paused) return;
        this.paused = true;
        this.stop();
        if (this.state === STATES.LEADER) {
            this.state = STATES.FOLLOWER;
            this.leaderId = null;
            this.leaderUrl = null;
        }
        console.log(`[${this.replicaId}] *** PAUSED (simulated failure) ***`);
    }

    resume() {
        if (!this.paused) return;
        this.paused = false;
        this.state = STATES.FOLLOWER;
        this.votes = 0;
        // votedFor is deliberately retained: clearing it in the same term could
        // let this node vote twice after a pause or restart.
        this._resetElectionTimer();
        console.log(`[${this.replicaId}] *** RESUMED · stable state restored ***`);
    }

    async _startElection() {
        if (this.paused) return;

        this.currentTerm += 1;
        this.metrics.electionsTotal += 1;
        this.state = STATES.CANDIDATE;
        this.votedFor = this.replicaId;
        this.votes = 1;
        this.leaderId = null;
        this.leaderUrl = null;
        this._persistState();

        const electionTerm = this.currentTerm;
        const lastLogIndex = this.log.length - 1;
        const lastLogTerm = lastLogIndex >= 0 ? this.log[lastLogIndex].term : 0;

        console.log(
            `[${this.replicaId}] Election started · term=${electionTerm} ` +
            `quorum=${this.quorumSize}/${this.clusterSize}`,
        );

        this._resetElectionTimer();
        if (this.votes >= this.quorumSize) {
            this._becomeLeader();
            return;
        }

        const voteRequests = this.peers.map(async (peerUrl) => {
            try {
                const response = await this.transport.post(
                    `${peerUrl}/request-vote`,
                    {
                        term: electionTerm,
                        candidateId: this.replicaId,
                        lastLogIndex,
                        lastLogTerm,
                    },
                    { timeout: 400 },
                );

                if (response.data.term > this.currentTerm) {
                    this._becomeFollower(response.data.term);
                    return;
                }

                if (
                    response.data.voteGranted &&
                    this.state === STATES.CANDIDATE &&
                    this.currentTerm === electionTerm
                ) {
                    this.votes += 1;
                    if (this.votes >= this.quorumSize) this._becomeLeader();
                }
            } catch (_) {
                // An unavailable peer is expected during an election.
            }
        });

        // Awaiting the fan-out keeps errors and election completion observable.
        await Promise.allSettled(voteRequests);
    }

    _becomeLeader() {
        if (this.state !== STATES.CANDIDATE) return;

        this.state = STATES.LEADER;
        this.leaderId = this.replicaId;
        this.leaderUrl = this.nodeUrl;
        this.votes = 0;
        if (this.quorumSize === 1) this.lastQuorumContactAt = Date.now();

        if (this._electionTimer) clearTimeout(this._electionTimer);
        this._electionTimer = null;

        for (const peerUrl of this.peers) {
            this.nextIndex[peerUrl] = this.log.length;
            this.matchIndex[peerUrl] = -1;
        }

        console.log(`[${this.replicaId}] *** LEADER · term=${this.currentTerm} ***`);
        if (this.onLeaderChange) {
            this.onLeaderChange(this.replicaId, this.nodeUrl);
        }
        this._startHeartbeat();
    }

    _becomeFollower(term, leaderId = null, leaderUrl = null) {
        const wasLeader = this.state === STATES.LEADER;
        const termAdvanced = term > this.currentTerm;

        if (termAdvanced) {
            this.currentTerm = term;
            this.votedFor = null;
            this._persistState();
        }

        this.state = STATES.FOLLOWER;
        this.votes = 0;
        this.leaderId = leaderId;
        this.leaderUrl = leaderUrl;
        this._stopHeartbeat();

        if (wasLeader) {
            console.log(`[${this.replicaId}] Stepped down · term=${this.currentTerm}`);
        }
        this._resetElectionTimer();
    }

    handleRequestVote({ term, candidateId, lastLogIndex, lastLogTerm }) {
        if (this.paused || term < this.currentTerm) {
            return { term: this.currentTerm, voteGranted: false };
        }
        if (term > this.currentTerm) this._becomeFollower(term);

        const myLastIndex = this.log.length - 1;
        const myLastTerm = myLastIndex >= 0 ? this.log[myLastIndex].term : 0;
        const candidateIsUpToDate =
            lastLogTerm > myLastTerm ||
            (lastLogTerm === myLastTerm && lastLogIndex >= myLastIndex);
        const canVote = this.votedFor === null || this.votedFor === candidateId;

        if (canVote && candidateIsUpToDate) {
            this.votedFor = candidateId;
            this._persistState();
            this._resetElectionTimer();
            console.log(`[${this.replicaId}] Vote persisted · ${candidateId} term=${term}`);
            return { term: this.currentTerm, voteGranted: true };
        }

        return { term: this.currentTerm, voteGranted: false };
    }

    handleAppendEntries({
        term,
        leaderId,
        leaderUrl,
        prevLogIndex = -1,
        prevLogTerm = 0,
        entries = [],
        leaderCommit = -1,
    }) {
        if (this.paused || term < this.currentTerm) {
            return {
                term: this.currentTerm,
                success: false,
                conflictIndex: this.log.length,
                logLength: this.log.length,
            };
        }

        const leaderChanged = this.leaderId !== leaderId;
        if (term > this.currentTerm || this.state !== STATES.FOLLOWER) {
            this._becomeFollower(term, leaderId, leaderUrl);
        } else {
            this.leaderId = leaderId;
            this.leaderUrl = leaderUrl;
            this._resetElectionTimer();
        }
        if (leaderChanged && this.onLeaderChange) {
            this.onLeaderChange(leaderId, leaderUrl);
        }
        this.lastQuorumContactAt = Date.now();

        if (prevLogIndex >= this.log.length) {
            return {
                term: this.currentTerm,
                success: false,
                conflictIndex: this.log.length,
                logLength: this.log.length,
            };
        }

        if (prevLogIndex >= 0 && this.log[prevLogIndex].term !== prevLogTerm) {
            const conflictingTerm = this.log[prevLogIndex].term;
            let conflictIndex = prevLogIndex;
            while (
                conflictIndex > 0 &&
                this.log[conflictIndex - 1].term === conflictingTerm
            ) {
                conflictIndex -= 1;
            }
            return {
                term: this.currentTerm,
                success: false,
                conflictIndex,
                conflictTerm: conflictingTerm,
                logLength: this.log.length,
            };
        }

        let changed = false;
        let offset = 0;
        let insertionIndex = prevLogIndex + 1;
        while (offset < entries.length && insertionIndex < this.log.length) {
            if (this.log[insertionIndex].term !== entries[offset].term) {
                this.log = this.log.slice(0, insertionIndex);
                changed = true;
                break;
            }
            offset += 1;
            insertionIndex += 1;
        }

        if (offset < entries.length) {
            this.log.push(...entries.slice(offset));
            changed = true;
        }

        if (changed) this._persistState();

        if (leaderCommit > this.commitIndex) {
            this.commitIndex = Math.min(leaderCommit, this.log.length - 1);
            this._persistState();
            this._applyCommittedEntries();
        }

        return {
            term: this.currentTerm,
            success: true,
            matchIndex: prevLogIndex + entries.length,
            logLength: this.log.length,
        };
    }

    _applyCommittedEntries() {
        while (this.lastApplied < this.commitIndex) {
            this.lastApplied += 1;
            const entry = this.log[this.lastApplied];
            if (entry && this.onCommit) {
                this.onCommit(entry, { isLeader: this.state === STATES.LEADER });
            }
        }
        this._persistState();
    }

    _advanceCommitIndex() {
        if (this.state !== STATES.LEADER) return;

        for (let index = this.log.length - 1; index > this.commitIndex; index -= 1) {
            // Figure 8 / §5.4.2: count replicas only for an entry from the
            // leader's current term.
            if (this.log[index].term !== this.currentTerm) continue;

            let replicated = 1; // the leader stores its own log
            for (const peerUrl of this.peers) {
                if ((this.matchIndex[peerUrl] ?? -1) >= index) replicated += 1;
            }

            if (replicated >= this.quorumSize) {
                this.commitIndex = index;
                this._persistState();
                this._applyCommittedEntries();
                console.log(
                    `[${this.replicaId}] Commit advanced · index=${index} ` +
                    `replicas=${replicated}/${this.clusterSize}`,
                );
                break;
            }
        }
    }

    async _replicateToPeer(peerUrl) {
        if (this.state !== STATES.LEADER || this.paused || this._replicating.has(peerUrl)) {
            return false;
        }

        this._replicating.add(peerUrl);
        try {
            const maxAttempts = Math.max(2, this.log.length + 1);
            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                if (this.state !== STATES.LEADER || this.paused) return false;

                const next = Math.max(
                    0,
                    Math.min(this.nextIndex[peerUrl] ?? this.log.length, this.log.length),
                );
                const prevLogIndex = next - 1;
                const prevLogTerm =
                    prevLogIndex >= 0 ? this.log[prevLogIndex].term : 0;
                const entries = this.log.slice(next);

                try {
                    const response = await this.transport.post(
                        `${peerUrl}/append-entries`,
                        {
                            term: this.currentTerm,
                            leaderId: this.replicaId,
                            leaderUrl: this.nodeUrl,
                            prevLogIndex,
                            prevLogTerm,
                            entries,
                            leaderCommit: this.commitIndex,
                        },
                        { timeout: 450 },
                    );

                    if (response.data.term > this.currentTerm) {
                        this._becomeFollower(response.data.term);
                        return false;
                    }

                    if (response.data.success) {
                        const acknowledged = Number.isInteger(response.data.matchIndex)
                            ? response.data.matchIndex
                            : prevLogIndex + entries.length;
                        this.matchIndex[peerUrl] = Math.max(
                            this.matchIndex[peerUrl] ?? -1,
                            acknowledged,
                        );
                        this.nextIndex[peerUrl] = this.matchIndex[peerUrl] + 1;
                        this._advanceCommitIndex();
                        return true;
                    }

                    const hinted = Number.isInteger(response.data.conflictIndex)
                        ? response.data.conflictIndex
                        : Number.isInteger(response.data.logLength)
                            ? response.data.logLength
                            : next - 1;
                    this.nextIndex[peerUrl] = Math.max(
                        0,
                        hinted >= next ? next - 1 : hinted,
                    );
                } catch (_) {
                    return false;
                }
            }
            return false;
        } finally {
            this._replicating.delete(peerUrl);
        }
    }

    async _replicateAll() {
        if (this.state !== STATES.LEADER || this.paused) return;
        const results = await Promise.allSettled(
            this.peers.map((peerUrl) => this._replicateToPeer(peerUrl)),
        );
        const reachable = 1 + results.filter(
            (result) => result.status === 'fulfilled' && result.value === true,
        ).length;
        if (reachable >= this.quorumSize) this.lastQuorumContactAt = Date.now();
    }

    _findDuplicate(data) {
        if (!data || !data.clientId || !Number.isInteger(data.seqNo)) return -1;
        return this.log.findIndex(
            (entry) =>
                entry.data &&
                entry.data.clientId === data.clientId &&
                entry.data.seqNo === data.seqNo,
        );
    }

    async clientAppend(data) {
        const appendStartedAt = Date.now();
        if (this.state !== STATES.LEADER) {
            throw new Error(`Not the leader. Current leader: ${this.leaderId || 'unknown'}`);
        }

        const duplicateIndex = this._findDuplicate(data);
        if (duplicateIndex >= 0) {
            if (duplicateIndex > this.commitIndex) await this._replicateAll();
            return {
                committed: this.commitIndex >= duplicateIndex,
                entry: this.log[duplicateIndex],
                duplicate: true,
            };
        }

        const entry = {
            term: this.currentTerm,
            index: this.log.length,
            data,
        };
        this.log.push(entry);
        this._persistState();

        console.log(`[${this.replicaId}] Entry persisted · index=${entry.index}`);
        await this._replicateAll();
        this._advanceCommitIndex();

        const committed = this.commitIndex >= entry.index;
        if (committed) this._recordCommitLatency(Date.now() - appendStartedAt);
        return {
            committed,
            entry,
            duplicate: false,
        };
    }

    _recordCommitLatency(milliseconds) {
        this.metrics.commitLatencyCount += 1;
        this.metrics.commitLatencySumMs += milliseconds;
        for (const boundary of Object.keys(this.metrics.commitLatencyBuckets).map(Number)) {
            if (milliseconds <= boundary) this.metrics.commitLatencyBuckets[boundary] += 1;
        }
    }

    isReady() {
        if (this.paused || this.state === STATES.CANDIDATE) return false;
        const leaseWindow = this.electionTimeoutMax * 3;
        return Boolean(this.leaderId) && Date.now() - this.lastQuorumContactAt <= leaseWindow;
    }

    getStatus() {
        const replicated = this.state === STATES.LEADER
            ? Object.values(this.matchIndex).filter(
                (index) => index >= this.commitIndex && this.commitIndex >= 0,
            ).length + 1
            : null;

        return {
            replicaId: this.replicaId,
            state: this.paused ? 'PAUSED' : this.state,
            term: this.currentTerm,
            logLength: this.log.length,
            commitIndex: this.commitIndex,
            lastApplied: this.lastApplied,
            leaderId: this.leaderId,
            paused: this.paused,
            clusterSize: this.clusterSize,
            quorumSize: this.quorumSize,
            replicated,
            durable: Boolean(this._store),
            ready: this.isReady(),
            electionsTotal: this.metrics.electionsTotal,
        };
    }

    isLeader() {
        return this.state === STATES.LEADER && !this.paused;
    }
}

module.exports = { RaftNode, StableStateStore, STATES };
