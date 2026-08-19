/**
 * raft.js — a compact, defensible Raft consensus engine.
 *
 * Implements the safety-critical pieces used by the demo:
 *  - stable term / vote / log persistence before RPC responses
 *  - randomized elections with a dynamic majority
 *  - PreVote, so an isolated follower cannot inflate the cluster term
 *  - AppendEntries for both replication and heartbeats
 *  - nextIndex / matchIndex catch-up
 *  - the Raft §5.4.2 current-term commit rule
 *  - client request deduplication through clientId + seqNo
 *  - deterministic application into a replicated state machine
 *
 * Durability is split across two files. Metadata (term, vote, commit index) is
 * small and rewritten in place; the log is append-only and lives in its own
 * file. See log-store.js for why.
 *
 * `lastApplied` is deliberately *not* persisted. Recording how far we applied
 * without also persisting the state that application produced is a silent
 * data-loss bug: the node restarts, believes it already applied everything,
 * and serves an empty keyspace. Instead the committed prefix is replayed into
 * the state machine on boot. Application is deterministic, so replay is exact,
 * and it is free until the log is large enough to need compaction.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { LogStore } = require('./log-store');
const { StateMachine } = require('./state-machine');

const STATES = {
    FOLLOWER: 'FOLLOWER',
    CANDIDATE: 'CANDIDATE',
    LEADER: 'LEADER',
};

/** Wall clock and host timers. Replaced wholesale under simulation. */
const REAL_CLOCK = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
};

/**
 * Small, rewritten-in-place record of the values Raft §5.2 requires on stable
 * storage before an RPC that depends on them is answered.
 */
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
        peers = [],
        members = null,
        nodeUrl = null,
        onCommit,
        onLeaderChange,
        storagePath,
        logPath,
        stableStore = null,
        logStore = null,
        stateMachine,
        transport = axios,
        /**
         * Every read of the clock and every timer goes through here.
         *
         * This is the single change that makes the whole engine deterministically
         * simulatable. With a virtual clock, an entire cluster — elections,
         * heartbeats, timeouts, lease expiry — runs inside one process with no
         * real time passing, driven by an event queue. A thousand-operation run
         * under injected partitions takes milliseconds instead of minutes, and
         * more importantly it is *reproducible*: the same seed replays the same
         * interleaving, so a bug found by fuzzing can be debugged instead of
         * merely observed.
         *
         * This is the approach FoundationDB and TigerBeetle use, and it is
         * strictly stronger than injecting faults into a real network with
         * `tc netem`, where a failure that appears once may never appear again.
         */
        clock = REAL_CLOCK,
        /**
         * Source of the election-timeout jitter.
         *
         * This was `Math.random()` inline, which quietly broke the one property
         * the whole simulation harness is built on: that a run is a pure
         * function of its seed. Election timing drove every schedule, so
         * replaying a "reproducible" failure produced a different interleaving
         * and the bug appeared to vanish. A seed that failed in a batch would
         * pass in isolation — the most misleading possible symptom, because it
         * reads as a flaky harness rather than as unseeded randomness.
         */
        random = Math.random,
        randomElectionTimeout = null,
        autoStart = true,
        electionTimeoutMin = 500,
        electionTimeoutMax = 800,
        heartbeatInterval = 150,
        leaseTickInterval = 250,
        commitTimeoutMs = 2000,
    }) {
        this._clock = clock;
        this._random = random;
        this._randomElectionTimeout = randomElectionTimeout;
        this.replicaId = replicaId;
        this.nodeUrl = nodeUrl;
        /**
         * How this node names itself inside a configuration.
         *
         * `nodeUrl` is how peers address it, but it is optional — plenty of
         * tests and single-node uses never set one. Falling back to replicaId
         * means membership always has a stable identity for self, instead of
         * quietly putting `undefined` in the member list and computing a quorum
         * that excludes this node from its own cluster.
         */
        this.selfId = nodeUrl || replicaId;

        /**
         * ── Cluster membership (Raft §6) ─────────────────────────────────────
         *
         * The set of servers is not configuration passed in at boot; it is a
         * value *in the replicated log*, so every server agrees on it through
         * the same mechanism it agrees on everything else.
         *
         * `bootstrapMembers` is only the starting point, used until the log
         * contains a config entry. After that the log wins — including after a
         * restart, which is why a node that was added while it was down comes
         * back knowing it is a member.
         */
        this.bootstrapMembers = [...(members || [...peers, this.selfId])].filter(Boolean);
        /** Voting members. Counted for quorum and for elections. */
        this.members = [...this.bootstrapMembers];
        /**
         * Non-voting members. They receive the log and can be read from, but
         * are not counted in any majority.
         *
         * This exists because adding a fresh server straight into the voter set
         * is dangerous: its log is empty, so quorum now includes a node that
         * cannot acknowledge anything, and the cluster can stall until it
         * catches up. Learners take the catch-up cost outside the quorum.
         */
        this.learners = [];
        /** Everyone this node replicates to. Derived; never assign directly. */
        this.peers = [];
        this.onCommit = onCommit;
        this.onLeaderChange = onLeaderChange;
        this.transport = transport;

        this.electionTimeoutMin = electionTimeoutMin;
        this.electionTimeoutMax = electionTimeoutMax;
        this.heartbeatInterval = heartbeatInterval;
        this.leaseTickInterval = leaseTickInterval;
        this.commitTimeoutMs = commitTimeoutMs;

        this.stateMachine = stateMachine || new StateMachine();

        // Computed lazily. The old version built this path unconditionally,
        // touching `process.env` and `process.cwd()` even when storage was
        // disabled — which is wasted work in Node and a hard crash anywhere
        // `process` does not exist, such as a browser.
        const defaultStoragePath = () => path.join(
            (typeof process !== 'undefined' && process.env.DATA_DIR)
                || path.join(process.cwd(), 'data'),
            `${replicaId}.json`,
        );
        // Stores can be injected. Under simulation they are memory-backed but
        // *survive a simulated crash*, which is what makes it possible to test
        // the actual durability guarantee — that a node which acknowledged a
        // vote or an entry still remembers it after restarting. A simulation
        // where restart wipes state would silently pass a Raft implementation
        // that never persisted anything.
        this.storagePath = storagePath == null ? defaultStoragePath() : storagePath;
        this._store = stableStore
            ?? (this.storagePath === false ? null : new StableStateStore(this.storagePath));
        this.logPath = this.storagePath === false
            ? false
            : logPath || this.storagePath.replace(/\.json$/, '') + '.log';
        this._logStore = logStore
            ?? (this.logPath === false ? null : new LogStore(this.logPath));

        const stable = this._store ? this._store.load() : {};

        // Persistent state (§5.2). These values are written synchronously before
        // any RPC that depends on them is answered.
        this.currentTerm = Number.isInteger(stable.currentTerm) ? stable.currentTerm : 0;
        this.votedFor = typeof stable.votedFor === 'string' ? stable.votedFor : null;
        this.log = this._logStore ? this._logStore.load() : [];

        // Migration from the single-file format, where the log lived inside the
        // metadata document. Runs once, then the old copy is dropped.
        if (this.log.length === 0 && Array.isArray(stable.log) && stable.log.length > 0) {
            this.log = stable.log;
            this._logStore.rewrite(this.log);
            console.log(
                `[${replicaId}] migrated ${this.log.length} entries out of the metadata file`,
            );
        }

        // commitIndex is volatile in the paper. Persisting it is still safe —
        // it only ever advances, and a committed entry stays committed — and it
        // lets a restarted node rebuild its state machine without first waiting
        // to hear from a leader.
        const storedCommit = Number.isInteger(stable.commitIndex) ? stable.commitIndex : -1;
        this.commitIndex = Math.min(storedCommit, this.log.length - 1);
        this.lastApplied = -1;

        // Leader volatile state, keyed by peer URL.
        this.nextIndex = {};
        this.matchIndex = {};

        this.state = STATES.FOLLOWER;
        this.leaderId = null;
        this.leaderUrl = null;
        this.votes = 0;
        // Monotonic token used to discard late PreVote replies after a leader
        // heartbeat, term change, pause, or newer pre-election round.
        this._preVoteRound = 0;
        this.paused = false;

        this._timersEnabled = autoStart;
        this._electionTimer = null;
        this._heartbeatTimer = null;
        this._leaseTickTimer = null;
        // Index of this term's no-op. Null until this node leads.
        this._noopIndex = null;
        this._commitBroadcastQueued = false;
        this._commitWaiters = new Set();
        this._replicating = new Set();
        this.lastQuorumContactAt = 0;
        // When this node last heard from a leader; drives disruption prevention.
        this.lastLeaderContactAt = 0;
        this.metrics = {
            preVotesTotal: 0,
            electionsTotal: 0,
            replayedEntries: 0,
            commitLatencyCount: 0,
            commitLatencySumMs: 0,
            commitLatencyBuckets: { 10: 0, 25: 0, 50: 0, 100: 0, 250: 0, 500: 0, 1000: 0 },
        };

        // Adopt the configuration recorded in the log before anything else —
        // a restarted node must not campaign under a membership it has already
        // been voted out of, nor ignore one it has been added to.
        this._refreshConfiguration();

        // Rebuild the keyspace from the committed prefix before serving anyone.
        this._applyCommittedEntries({ replay: true });
        this.metrics.replayedEntries = this.lastApplied + 1;

        if (autoStart) this._resetElectionTimer();

        console.log(
            `[${this.replicaId}] Raft node ready · term=${this.currentTerm} ` +
            `log=${this.log.length} commit=${this.commitIndex} ` +
            `replayed=${this.metrics.replayedEntries} keys=${this.stateMachine.store.size}`,
        );
    }

    /** Voting members only. Learners are deliberately excluded. */
    get clusterSize() {
        return this.members.length;
    }

    get quorumSize() {
        return Math.floor(this.clusterSize / 2) + 1;
    }

    /** True when this node is itself a voter — false while it is a learner, or after removing itself. */
    get isVoter() {
        return this.members.includes(this.selfId);
    }

    /** Voting peers: the servers whose acknowledgements actually count. */
    get voterPeers() {
        return this.members.filter((url) => url !== this.selfId);
    }

    /**
     * Recomputes the active configuration from the log.
     *
     * ── The counterintuitive rule ────────────────────────────────────────────
     * A configuration entry takes effect the moment it is **appended**, not
     * when it commits. That feels wrong — we are acting on an entry that might
     * still be rolled back — but the alternative is worse: if servers waited
     * for commit, the old and new configurations would both be live with no
     * overlap guarantee during the window, and two disjoint majorities could
     * each elect a leader.
     *
     * The corollary is that a truncation must also roll the configuration
     * *back*. Rather than track that incrementally and get it subtly wrong,
     * this rescans from the end of the log for the newest config entry after
     * every mutation. It is O(log) per append, which at this scale is free, and
     * it is impossible to leave in an inconsistent state.
     */
    _refreshConfiguration() {
        let members = this.bootstrapMembers;
        let learners = [];

        for (let i = this.log.length - 1; i >= 0; i -= 1) {
            const data = this.log[i] && this.log[i].data;
            if (data && data.op === 'config') {
                members = data.members;
                learners = data.learners || [];
                break;
            }
        }

        const previouslyVoter = this.members.includes(this.selfId);
        this.members = [...members];
        this.learners = [...learners];

        // Replicate to voters and learners alike; only the former are counted.
        this.peers = [...new Set([...this.members, ...this.learners])]
            .filter((url) => url !== this.selfId);

        for (const peerUrl of this.peers) {
            if (this.nextIndex[peerUrl] === undefined) this.nextIndex[peerUrl] = this.log.length;
            if (this.matchIndex[peerUrl] === undefined) this.matchIndex[peerUrl] = -1;
        }

        // A leader that has just removed itself keeps serving until the entry
        // commits — see _advanceCommitIndex — but must never campaign again.
        if (previouslyVoter && !this.isVoter && this.state === STATES.LEADER) {
            console.log(`[${this.replicaId}] removed from the configuration; will step down once it commits`);
        }
    }

    /** The configuration entry currently in effect, for observability. */
    get configuration() {
        return { members: [...this.members], learners: [...this.learners] };
    }

    _persistentSnapshot() {
        return {
            version: 2,
            currentTerm: this.currentTerm,
            votedFor: this.votedFor,
            commitIndex: this.commitIndex,
        };
    }

    /** Durably records term / vote / commitIndex. Cheap: the file is ~100 bytes. */
    _persistState() {
        if (this._store) this._store.save(this._persistentSnapshot());
    }

    /**
     * The single place entries enter the log. Memory and disk are updated
     * together so the two can never drift.
     */
    _appendToLog(entries) {
        if (entries.length === 0) return;
        this.log.push(...entries);
        if (this._logStore) this._logStore.append(entries);
        // Config entries are live the instant they land. See _refreshConfiguration.
        if (entries.some((e) => e.data && e.data.op === 'config')) this._refreshConfiguration();
    }

    /**
     * Drops the suffix starting at `index`. Truncating at or below commitIndex
     * would discard an entry that a majority already acknowledged, which is a
     * direct violation of the State Machine Safety property — if it ever
     * happens the protocol is broken and crashing is preferable to serving
     * divergent state.
     */
    _truncateLogFrom(index) {
        if (index <= this.commitIndex) {
            throw new Error(
                `[${this.replicaId}] refusing to truncate at ${index} with commitIndex ` +
                `${this.commitIndex}: committed entries must never be discarded`,
            );
        }
        if (index >= this.log.length) return;
        const hadConfig = this.log.slice(index).some((e) => e.data && e.data.op === 'config');
        this.log = this.log.slice(0, index);
        if (this._logStore) this._logStore.rewrite(this.log);
        // Rolling back a config entry must roll back the configuration with it,
        // or a node keeps enforcing a membership the cluster has discarded.
        if (hadConfig) this._refreshConfiguration();
    }

    _randomTimeout() {
        if (this._randomElectionTimeout) {
            return this._randomElectionTimeout(this.electionTimeoutMin, this.electionTimeoutMax);
        }
        const spread = Math.max(1, this.electionTimeoutMax - this.electionTimeoutMin);
        return Math.floor(this._random() * spread) + this.electionTimeoutMin;
    }

    _resetElectionTimer() {
        if (this._electionTimer) this._clock.clearTimeout(this._electionTimer);
        if (!this._timersEnabled || this.paused || this.state === STATES.LEADER) return;

        this._electionTimer = this._clock.setTimeout(() => {
            this._startPreVote().catch((error) => {
                console.error('[' + this.replicaId + '] PreVote failed: ' + error.message);
                this._resetElectionTimer();
            });
        }, this._randomTimeout());
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        void this._replicateAll();
        this._heartbeatTimer = this._clock.setInterval(
            () => void this._replicateAll(),
            this.heartbeatInterval,
        );
    }

    _stopHeartbeat() {
        if (this._heartbeatTimer) this._clock.clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
    }

    stop() {
        this._preVoteRound += 1;
        if (this._electionTimer) this._clock.clearTimeout(this._electionTimer);
        this._electionTimer = null;
        this._stopHeartbeat();
        if (this._leaseTickTimer) this._clock.clearInterval(this._leaseTickTimer);
        this._leaseTickTimer = null;
        if (this._logStore) this._logStore.close();
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
        this._failCommitWaiters();
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

    /**
     * Asks whether an election could win before incrementing the durable term.
     *
     * Without PreVote, a node isolated from an otherwise healthy cluster keeps
     * timing out and increasing its term. When the partition heals, that large
     * term forces the healthy leader to step down even though the isolated node
     * never had a quorum. PreVote makes the disruptive action conditional on
     * first hearing from a majority, and deliberately changes no persistent
     * state on either the requester or the receivers.
     */
    async _startPreVote() {
        if (this.paused) return false;
        if (!this.isVoter) {
            this._resetElectionTimer();
            return false;
        }

        const round = ++this._preVoteRound;
        const prospectiveTerm = this.currentTerm + 1;
        const lastLogIndex = this.log.length - 1;
        const lastLogTerm = lastLogIndex >= 0 ? this.log[lastLogIndex].term : 0;
        let granted = 1;
        this.metrics.preVotesTotal += 1;

        // A lost or split pre-election must retry without mutating currentTerm.
        this._resetElectionTimer();
        if (granted >= this.quorumSize) {
            await this._startElection(prospectiveTerm, round);
            return true;
        }

        const requests = this.voterPeers.map(async (peerUrl) => {
            try {
                const response = await this.transport.post(
                    peerUrl + '/pre-vote',
                    {
                        term: prospectiveTerm,
                        candidateId: this.replicaId,
                        candidateUrl: this.selfId,
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
                    response.data.preVoteGranted
                    && this._preVoteRound === round
                    && this.currentTerm + 1 === prospectiveTerm
                    && this.state !== STATES.LEADER
                ) {
                    granted += 1;
                    if (granted >= this.quorumSize) {
                        await this._startElection(prospectiveTerm, round);
                    }
                }
            } catch (_) {
                // Silence is an expected negative pre-vote during a partition.
            }
        });

        await Promise.allSettled(requests);
        return this.state === STATES.LEADER || this.state === STATES.CANDIDATE;
    }

    async _startElection(expectedTerm = null, preVoteRound = null) {
        if (this.paused) return;
        // A learner has no vote and must never try to take leadership. Without
        // this a freshly-added server that is still catching up can time out and
        // start disrupting elections in a cluster it is not yet part of.
        if (!this.isVoter) {
            this._resetElectionTimer();
            return;
        }
        // A heartbeat or a newer pre-election invalidates late quorum replies.
        if (expectedTerm !== null && (
            expectedTerm !== this.currentTerm + 1
            || (preVoteRound !== null && preVoteRound !== this._preVoteRound)
        )) return;


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

        const voteRequests = this.voterPeers.map(async (peerUrl) => {
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
        if (this.quorumSize === 1) this.lastQuorumContactAt = this._clock.now();

        if (this._electionTimer) this._clock.clearTimeout(this._electionTimer);
        this._electionTimer = null;

        for (const peerUrl of this.peers) {
            this.nextIndex[peerUrl] = this.log.length;
            this.matchIndex[peerUrl] = -1;
        }

        /**
         * The no-op entry Raft §8 requires at the start of every term.
         *
         * A newly elected leader knows its log contains every committed entry —
         * that is what the election restriction guarantees — but it does *not*
         * know how far its predecessor had committed. `commitIndex` starts from
         * whatever this node had locally, which may lag reality.
         *
         * That gap is invisible for writes and fatal for reads. A ReadIndex read
         * takes the current commitIndex as its barrier, so a fresh leader whose
         * commitIndex is behind will answer from a state machine missing writes
         * that were acknowledged to clients before it took over.
         *
         * A linearizability fuzz run found exactly this: a write acknowledged at
         * t=316 was invisible to a read issued at t=1051, across a leader change,
         * while every replica's log and committed prefix agreed perfectly. The
         * bug was not in replication at all.
         *
         * Committing one entry from the current term forces commitIndex up to
         * the true committed frontier — because committing it requires a
         * majority to have this term's log, which by the log-matching property
         * carries everything before it.
         */
        this._noopIndex = this.log.length;
        this._appendToLog([{
            term: this.currentTerm,
            index: this._noopIndex,
            ts: this._clock.now(),
            data: { op: 'noop', leader: this.replicaId },
        }]);

        console.log(`[${this.replicaId}] *** LEADER · term=${this.currentTerm} ***`);
        if (this.onLeaderChange) {
            this.onLeaderChange(this.replicaId, this.nodeUrl);
        }
        this._startHeartbeat();
        this._syncLeaseTicks();
    }

    _becomeFollower(term, leaderId = null, leaderUrl = null) {
        this._preVoteRound += 1;
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
        this._syncLeaseTicks();
        // Anything this node proposed and had not committed by the time it lost
        // leadership will never commit under its authority. Waking those
        // callers with a definite "no" is far better than holding their request
        // open until the timeout.
        this._failCommitWaiters();

        if (wasLeader) {
            console.log(`[${this.replicaId}] Stepped down · term=${this.currentTerm}`);
        }
        this._resetElectionTimer();
    }

    /**
     * Read-only half of PreVote. It intentionally does not update currentTerm,
     * votedFor, stable storage, or the election timer.
     */
    handlePreVote({ term, candidateId, candidateUrl = null, lastLogIndex, lastLogTerm }) {
        if (this.paused || term < this.currentTerm + 1) {
            return { term: this.currentTerm, preVoteGranted: false };
        }

        const candidateIsMember = candidateUrl === null || this.members.includes(candidateUrl);
        const heardFromLeaderRecently = this.leaderId
            && this._clock.now() - this.lastLeaderContactAt < this.electionTimeoutMin;
        const myLastIndex = this.log.length - 1;
        const myLastTerm = myLastIndex >= 0 ? this.log[myLastIndex].term : 0;
        const candidateIsUpToDate = lastLogTerm > myLastTerm
            || (lastLogTerm === myLastTerm && lastLogIndex >= myLastIndex);
        const preVoteGranted = Boolean(
            this.isVoter
            && this.state !== STATES.LEADER
            && candidateId
            && candidateIsMember
            && !heardFromLeaderRecently
            && candidateIsUpToDate,
        );

        return { term: this.currentTerm, preVoteGranted };
    }

    handleRequestVote({ term, candidateId, lastLogIndex, lastLogTerm, force = false }) {
        if (this.paused || term < this.currentTerm) {
            return { term: this.currentTerm, voteGranted: false };
        }

        /**
         * ── The removed-server problem (thesis §4.2.3) ───────────────────────
         *
         * A server that has been removed from the configuration does not find
         * out — nobody sends it anything any more. So it times out, increments
         * its term, and campaigns. Its RequestVote carries a term higher than
         * the live cluster's, which forces the healthy leader to step down even
         * though the candidate cannot win. It then times out again, and again,
         * disrupting the cluster indefinitely for as long as it is left running.
         *
         * The fix is to let a follower refuse to even consider a vote while it
         * is still hearing from a leader. A candidate that a majority is happy
         * with cannot be displaced by a stranger with a big number.
         *
         * This is safe because it only ever *delays* an election: if the leader
         * really is gone, contact goes stale within one minimum election
         * timeout and the rule stops applying.
         */
        const heardFromLeaderRecently = this.leaderId
            && this._clock.now() - this.lastLeaderContactAt < this.electionTimeoutMin;
        if (heardFromLeaderRecently && !force) {
            return {
                term: this.currentTerm,
                voteGranted: false,
                reason: 'a leader is still alive',
            };
        }
        if (term > this.currentTerm) this._becomeFollower(term);

        const myLastIndex = this.log.length - 1;
        const myLastTerm = myLastIndex >= 0 ? this.log[myLastIndex].term : 0;
        const candidateIsUpToDate =
            lastLogTerm > myLastTerm ||
            (lastLogTerm === myLastTerm && lastLogIndex >= myLastIndex);
        const canVote = this.votedFor === null || this.votedFor === candidateId;

        if (canVote && candidateIsUpToDate) {
            this._preVoteRound += 1;
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
            this._preVoteRound += 1;
            this.leaderId = leaderId;
            this.leaderUrl = leaderUrl;
            this._resetElectionTimer();
        }
        if (leaderChanged && this.onLeaderChange) {
            this.onLeaderChange(leaderId, leaderUrl);
        }
        this.lastQuorumContactAt = this._clock.now();
        this.lastLeaderContactAt = this._clock.now();

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

        let offset = 0;
        let insertionIndex = prevLogIndex + 1;
        while (offset < entries.length && insertionIndex < this.log.length) {
            if (this.log[insertionIndex].term !== entries[offset].term) {
                this._truncateLogFrom(insertionIndex);
                break;
            }
            offset += 1;
            insertionIndex += 1;
        }

        // Entries already present are skipped, so a retried AppendEntries does
        // not rewrite the log and does not cost an fsync.
        this._appendToLog(entries.slice(offset));

        if (leaderCommit > this.commitIndex) {
            /**
             * Cap at the last index this RPC actually verified, not at the end
             * of the local log.
             *
             * The obvious `Math.min(leaderCommit, this.log.length - 1)` is
             * wrong, and a fuzz run caught it as replicas disagreeing on a
             * *committed* entry — index 18 held term 12 on one node and term 10
             * on another.
             *
             * The sequence: a follower still holds uncommitted entries from a
             * deposed leader beyond the point this AppendEntries covers. The
             * new leader's `leaderCommit` refers to *its* log, so taking the
             * local log length as the bound marks those stale entries committed
             * — before the leader has caught the follower up and truncated
             * them. They are then applied, and the next AppendEntries replaces
             * them with different entries at the same indexes.
             *
             * `prevLogIndex + entries.length` is the last index the log-matching
             * property guarantees is identical to the leader's, so it is the
             * only safe bound.
             */
            const lastVerifiedIndex = prevLogIndex + entries.length;
            const next = Math.min(leaderCommit, lastVerifiedIndex);
            if (next > this.commitIndex) {
                this.commitIndex = next;
                this._persistState();
                this._applyCommittedEntries();
            }
        }

        return {
            term: this.currentTerm,
            success: true,
            matchIndex: prevLogIndex + entries.length,
            logLength: this.log.length,
        };
    }

    /**
     * Applies every newly committed entry, in index order.
     *
     * The state machine mutation is synchronous and happens first; only then
     * are side effects fired. Previously `onCommit` was an async function
     * invoked without await from inside this loop, so gateway notifications
     * could interleave and arrive out of order. Ordering is the entire point of
     * a replicated log — losing it at the last step defeats the exercise.
     */
    _applyCommittedEntries({ replay = false } = {}) {
        while (this.lastApplied < this.commitIndex) {
            this.lastApplied += 1;
            const entry = this.log[this.lastApplied];
            if (!entry) continue;

            const result = this.stateMachine.apply(entry);

            if (this.onCommit) {
                // Side effects are fire-and-forget by design, but they run
                // after the deterministic state is already correct, and they
                // are suppressed during replay so a restart does not
                // re-broadcast history that clients have already seen.
                Promise.resolve()
                    .then(() => this.onCommit(entry, {
                        isLeader: this.state === STATES.LEADER,
                        replay,
                        result,
                    }))
                    .catch((error) => {
                        console.error(
                            `[${this.replicaId}] commit hook failed at ${entry.index}: ${error.message}`,
                        );
                    });
            }
        }
    }

    _advanceCommitIndex() {
        if (this.state !== STATES.LEADER) return;

        for (let index = this.log.length - 1; index > this.commitIndex; index -= 1) {
            // Figure 8 / §5.4.2: count replicas only for an entry from the
            // leader's current term.
            if (this.log[index].term !== this.currentTerm) continue;

            // Only voters count. A learner acknowledging an entry must never
            // contribute to a majority — that is the entire point of it being a
            // learner — and a leader that has removed itself no longer counts
            // its own copy either.
            let replicated = this.isVoter ? 1 : 0;
            for (const peerUrl of this.voterPeers) {
                if ((this.matchIndex[peerUrl] ?? -1) >= index) replicated += 1;
            }

            if (replicated >= this.quorumSize) {
                this.commitIndex = index;
                this._persistState();
                this._applyCommittedEntries();
                this._releaseCommitWaiters();
                this._scheduleCommitBroadcast();
                console.log(
                    `[${this.replicaId}] Commit advanced · index=${index} ` +
                    `replicas=${replicated}/${this.clusterSize}`,
                );
                break;
            }
        }
    }

    /**
     * Commit is a decision the leader makes alone; followers only learn about
     * it from the `leaderCommit` field on a later AppendEntries. Left to the
     * heartbeat that is up to `heartbeatInterval` of pointless staleness on
     * every follower — which matters here because watches are deliberately
     * served from followers.
     *
     * Pushing the new commit index out immediately closes that gap. It is
     * deferred to the next tick so it cannot re-enter the replication path that
     * triggered it, and coalesced so a burst of commits costs one extra round.
     */
    _scheduleCommitBroadcast() {
        if (this._commitBroadcastQueued || this.state !== STATES.LEADER) return;
        this._commitBroadcastQueued = true;
        // Through the clock, not setImmediate. A real macrotask escapes virtual
        // time entirely, so under simulation its ordering relative to timer
        // callbacks depended on how much unrelated work the host event loop
        // happened to have queued — nondeterminism smuggled in through the one
        // call that looked too trivial to matter.
        this._clock.setTimeout(() => {
            // Index of this term's no-op. Null until this node leads.
        this._noopIndex = null;
        this._commitBroadcastQueued = false;
            if (this.state === STATES.LEADER && !this.paused) void this._replicateAll();
        }, 0);
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
        if (reachable >= this.quorumSize) this.lastQuorumContactAt = this._clock.now();

        // Also covers the cases where no peer acknowledged on this pass: a
        // single-node cluster, where the leader alone is the majority, and a
        // cluster where every peer was mid-request and got skipped.
        this._advanceCommitIndex();
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
        const appendStartedAt = this._clock.now();
        if (this.state !== STATES.LEADER) {
            throw new Error(`Not the leader. Current leader: ${this.leaderId || 'unknown'}`);
        }

        const duplicateIndex = this._findDuplicate(data);
        if (duplicateIndex >= 0) {
            const committed = await this._awaitCommit(duplicateIndex);
            return {
                committed,
                entry: this.log[duplicateIndex],
                // A retried CAS must return the *original* verdict. Replaying
                // the comparison against current state would report failure for
                // a swap this very client already won.
                result: committed ? this.stateMachine.resultFor(duplicateIndex) : null,
                duplicate: true,
            };
        }

        const entry = {
            term: this.currentTerm,
            index: this.log.length,
            // The leader's wall clock, stamped once, at append. Every replica
            // then derives lease expiry from this same number rather than from
            // its own clock. See the header of state-machine.js.
            ts: this._clock.now(),
            data,
        };
        this._appendToLog([entry]);

        console.log(`[${this.replicaId}] Entry persisted · index=${entry.index}`);
        void this._replicateAll();

        const committed = await this._awaitCommit(entry.index);
        if (committed) this._recordCommitLatency(this._clock.now() - appendStartedAt);
        this._syncLeaseTicks();
        return {
            committed,
            entry,
            result: committed ? this.stateMachine.resultFor(entry.index) : null,
            duplicate: false,
        };
    }

    /**
     * Resolves once `index` is committed, or false if it has not committed
     * within the timeout.
     *
     * The obvious implementation — fire one round of replication and check
     * commitIndex — is wrong, and wrong in a way that only shows up on a real
     * multi-node cluster. `_replicateToPeer` refuses to run while a request to
     * that peer is already in flight, so a client write that happens to land
     * during a heartbeat gets zero acknowledgements and is reported as
     * uncommitted, even though the next heartbeat commits it milliseconds
     * later. Clients then retry writes that already succeeded.
     *
     * Waiting on the commit index itself is the honest condition. Heartbeats
     * keep driving replication in the background, so the wait resolves as soon
     * as a majority actually has the entry.
     */
    _awaitCommit(index, timeoutMs = this.commitTimeoutMs) {
        if (this.commitIndex >= index) return Promise.resolve(true);
        if (this.state !== STATES.LEADER || this.paused) return Promise.resolve(false);

        return new Promise((resolve) => {
            const waiter = { index, resolve: null, timer: null };
            const settle = (value) => {
                if (waiter.resolve === null) return;
                waiter.resolve = null;
                this._clock.clearTimeout(waiter.timer);
                this._commitWaiters.delete(waiter);
                resolve(value);
            };
            waiter.resolve = settle;
            waiter.timer = this._clock.setTimeout(() => settle(this.commitIndex >= index), timeoutMs);
            if (waiter.timer && waiter.timer.unref) waiter.timer.unref();
            this._commitWaiters.add(waiter);
        });
    }

    _releaseCommitWaiters() {
        for (const waiter of [...this._commitWaiters]) {
            if (this.commitIndex >= waiter.index) waiter.resolve(true);
        }
    }

    /** A node that is no longer leader can never commit its pending entries. */
    _failCommitWaiters() {
        for (const waiter of [...this._commitWaiters]) {
            waiter.resolve(this.commitIndex >= waiter.index);
        }
    }

    // ── membership changes (Raft §6, single-server) ──────────────────────────

    /**
     * Adds one server.
     *
     * Single-server changes rather than joint consensus, which is what etcd
     * ships and what Ongaro recommends in the thesis. The safety argument is
     * one sentence: adding or removing *one* server means the old and new
     * majorities always overlap in at least one node, so two disjoint
     * majorities cannot both elect a leader. Change two at once — 3 nodes to 5
     * by adding both together — and {A,B} and {C,D,E} are each a majority of
     * their own configuration with nobody in common. That is split brain, and
     * it is why the restriction exists.
     *
     * The joiner is admitted as a **learner** first and only promoted once it
     * has caught up. Promoting immediately would put a node with an empty log
     * into the quorum, so a 3-node cluster becomes a 4-node cluster needing 3
     * acknowledgements, one of which cannot be given until the joiner has
     * replayed the entire history. Writes stall for exactly as long as that
     * takes.
     */
    async addServer(url, { catchUpTimeoutMs = 10000 } = {}) {
        if (!this.isLeader()) throw new Error('only the leader can change membership');
        if (this.members.includes(url)) return { ok: true, alreadyMember: true, ...this.configuration };
        this._assertNoPendingConfigChange();

        // Phase 1 — replicate to it without counting it.
        if (!this.learners.includes(url)) {
            const staged = await this._commitConfiguration(this.members, [...this.learners, url]);
            if (!staged.ok) return staged;
        }
        console.log(`[${this.replicaId}] ${url} joined as a learner; catching up`);

        // Phase 2 — wait for it to be near the leader's log before it votes.
        const caughtUp = await this._awaitCatchUp(url, catchUpTimeoutMs);
        if (!caughtUp) {
            // Roll the learner back out rather than leaving a half-finished
            // change behind. A stalled join that leaves debris is much harder to
            // reason about than one that cleanly failed.
            await this._commitConfiguration(this.members, this.learners.filter((u) => u !== url));
            return { ok: false, error: `${url} did not catch up within ${catchUpTimeoutMs}ms` };
        }

        // Phase 3 — promote to voter.
        const promoted = await this._commitConfiguration(
            [...this.members, url],
            this.learners.filter((u) => u !== url),
        );
        if (promoted.ok) console.log(`[${this.replicaId}] ${url} promoted to voter · quorum now ${this.quorumSize}/${this.clusterSize}`);
        return promoted;
    }

    /**
     * Removes one server.
     *
     * A leader removing *itself* is the interesting case. It must keep serving
     * until the entry commits, because it is the only node that can replicate
     * it — stepping down the moment the config is appended would strand the
     * change and force an election to finish it. Once committed, it steps down
     * immediately rather than continuing to lead a cluster it is not in.
     */
    async removeServer(url) {
        if (!this.isLeader()) throw new Error('only the leader can change membership');
        if (!this.members.includes(url) && !this.learners.includes(url)) {
            return { ok: true, notAMember: true, ...this.configuration };
        }
        this._assertNoPendingConfigChange();

        const remaining = this.members.filter((u) => u !== url);
        if (remaining.length === 0) return { ok: false, error: 'refusing to remove the last member' };

        const removingSelf = url === this.selfId;
        const result = await this._commitConfiguration(
            remaining,
            this.learners.filter((u) => u !== url),
        );

        if (result.ok && removingSelf) {
            console.log(`[${this.replicaId}] removed itself; stepping down`);
            this._becomeFollower(this.currentTerm);
        }
        // Stop tracking a server that is gone, so its stale matchIndex cannot
        // linger and be counted after a later re-add.
        if (result.ok) { delete this.nextIndex[url]; delete this.matchIndex[url]; }
        return result;
    }

    /**
     * At most one configuration change may be in flight.
     *
     * Two overlapping changes reintroduce exactly the disjoint-majority problem
     * that single-server changes exist to prevent, because the intermediate
     * configuration nobody agreed on becomes reachable.
     */
    _assertNoPendingConfigChange() {
        for (let i = this.log.length - 1; i > this.commitIndex; i -= 1) {
            if (this.log[i].data && this.log[i].data.op === 'config') {
                throw new Error('a configuration change is already in flight');
            }
        }
    }

    async _commitConfiguration(members, learners) {
        const outcome = await this.clientAppend({
            op: 'config',
            members: [...members],
            learners: [...learners],
        });
        return outcome.committed
            ? { ok: true, ...this.configuration, index: outcome.entry.index }
            : { ok: false, error: 'configuration change did not reach a quorum' };
    }

    /**
     * Waits until a server's log is close enough to the leader's to be useful.
     *
     * Actively replicates to it on each poll rather than waiting for the
     * regular heartbeat. Passive polling technically works, but it makes the
     * catch-up take as long as the heartbeat interval multiplied by the number
     * of entries the joiner is missing — and it does nothing at all when
     * heartbeats are not running, which is exactly the state a leader is in
     * during a test or immediately after an election.
     */
    async _awaitCatchUp(url, timeoutMs, slack = 2) {
        const deadline = this._clock.now() + timeoutMs;
        // Clamped at 0. Without the clamp, a short log makes the target
        // negative, and a joiner whose matchIndex is still -1 — meaning it has
        // acknowledged *nothing*, possibly because it is unreachable — compares
        // as caught up and gets promoted straight into the quorum. That is
        // precisely the stall the learner phase exists to prevent, reintroduced
        // by an off-by-one.
        const target = () => Math.max(0, this.log.length - 1 - slack);

        for (;;) {
            if (!this.isLeader()) return false;
            if ((this.matchIndex[url] ?? -1) >= target()) return true;
            if (this._clock.now() >= deadline) return false;

            // Drive it forward. `_replicateToPeer` walks nextIndex back on a
            // rejected consistency check, so repeated calls converge even when
            // the joiner starts from an empty log.
            await this._replicateToPeer(url);
            if ((this.matchIndex[url] ?? -1) >= target()) return true;

            await new Promise((resolve) => {
                const handle = this._clock.setTimeout(resolve, Math.min(this.heartbeatInterval, 25));
                if (handle && handle.unref) handle.unref();
            });
        }
    }

    /**
     * Leases expire against logical time, and logical time only advances when
     * an entry is appended. A quiet cluster would therefore hold every lease
     * open forever. The leader appends a no-op `tick` while any lease is
     * outstanding, and stops the moment the last one is gone — so an idle
     * cluster with no leases writes nothing at all.
     */
    _syncLeaseTicks() {
        const wanted = this.state === STATES.LEADER
            && !this.paused
            && this.stateMachine.activeLeaseCount > 0;

        if (wanted && !this._leaseTickTimer) {
            this._leaseTickTimer = this._clock.setInterval(() => {
                void this._appendTick();
            }, this.leaseTickInterval);
            if (this._leaseTickTimer && this._leaseTickTimer.unref) this._leaseTickTimer.unref();
        } else if (!wanted && this._leaseTickTimer) {
            this._clock.clearInterval(this._leaseTickTimer);
            this._leaseTickTimer = null;
        }
    }

    async _appendTick() {
        if (this.state !== STATES.LEADER || this.paused) {
            this._syncLeaseTicks();
            return;
        }

        // Only tick when something is actually due. A healthy holder renews,
        // and its renewal is itself a stamped entry that advances the clock, so
        // in the common case this appends nothing. Ticks are the mechanism for
        // noticing a holder that went away.
        let earliestExpiry = Infinity;
        for (const lease of this.stateMachine.leases.values()) {
            if (lease.expiresAt < earliestExpiry) earliestExpiry = lease.expiresAt;
        }
        if (this._clock.now() < earliestExpiry) return;

        try {
            await this.clientAppend({ op: 'tick' });
        } catch (error) {
            console.error(`[${this.replicaId}] lease tick failed: ${error.message}`);
        }
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
        return Boolean(this.leaderId) && this._clock.now() - this.lastQuorumContactAt <= leaseWindow;
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
            servingSemantics: 'quorum-aware serving and disruption prevention',
            preVotesTotal: this.metrics.preVotesTotal,
            electionsTotal: this.metrics.electionsTotal,
            replayedEntries: this.metrics.replayedEntries,
            keys: this.stateMachine.store.size,
            leases: this.stateMachine.activeLeaseCount,
            revision: this.stateMachine.revision,
            logicalClock: this.stateMachine.clock,
        };
    }

    isLeader() {
        return this.state === STATES.LEADER && !this.paused;
    }

    /**
     * Linearizable read.
     *
     * Serving a read straight from local state is fast and wrong: a leader that
     * has been partitioned away still believes it leads and will happily return
     * stale values. Requiring a fresh quorum lease is the cheap correct answer
     * — no log entry, but a caller only gets data from a node that heard from a
     * majority inside the last election timeout.
     */
    /**
     * Leader-lease read. Fast, and NOT linearizable — see below.
     *
     * ── The bug a fuzz run found here ────────────────────────────────────────
     * The first version of this used `electionTimeoutMax` as the lease window,
     * which is unsound, and the linearizability checker caught it: replicas
     * agreed on every log entry and every committed prefix, yet the
     * client-visible history admitted no valid sequential explanation. The
     * violation was entirely in this method.
     *
     * A follower may begin an election after `electionTimeoutMin`. A partitioned
     * leader that last heard from a quorum `electionTimeoutMin` ago therefore
     * cannot rule out that a new leader has already been elected and has
     * already committed writes — but with a window of `electionTimeoutMax` it
     * still believes its lease is live and answers from a log it stopped
     * receiving. That is a stale read, and it is a real-time-order violation.
     *
     * The window is now strictly shorter than the *minimum* election timeout,
     * with the round trip subtracted, because `lastQuorumContactAt` records
     * when the response arrived rather than when the peer actually saw it.
     *
     * Even correctly sized, a lease read trusts clocks. It is offered because
     * it is cheap and often acceptable; `readLinearizable` is offered for when
     * it is not.
     */
    read(fn) {
        if (!this.isLeader()) {
            throw new Error(`Not the leader. Current leader: ${this.leaderId || 'unknown'}`);
        }
        const window = Math.max(0, this.electionTimeoutMin - this.heartbeatInterval);
        if (this._clock.now() - this.lastQuorumContactAt > window) {
            throw new Error('Stale leader lease: no recent quorum contact');
        }
        return fn(this.stateMachine);
    }

    /**
     * ReadIndex — a linearizable read with no assumption about clocks.
     *
     *   1. record the current commitIndex
     *   2. confirm leadership *right now* with a fresh round of heartbeats
     *   3. wait until this node has applied up to the recorded index
     *   4. answer from local state
     *
     * Step 2 is the whole thing. A leader that has been deposed cannot get a
     * quorum to acknowledge its current term, so it discovers it is stale
     * before answering rather than after. Nothing here depends on how much
     * clock drift there is between machines — which is what makes it correct
     * where a lease is merely usually-correct.
     *
     * The cost is one round trip per read, which is why the lease version still
     * exists. Batching many concurrent reads behind a single confirmation round
     * is the standard next optimisation and is not implemented here.
     */
    async readLinearizable(fn) {
        if (!this.isLeader()) {
            throw new Error(`Not the leader. Current leader: ${this.leaderId || 'unknown'}`);
        }

        // Until this term's no-op commits, commitIndex may still be behind the
        // true committed frontier and this node cannot answer safely. Refusing
        // is correct; the client retries a moment later, or asks another node.
        if (this._noopIndex !== null && this.commitIndex < this._noopIndex) {
            throw new Error('Leader has not yet committed its term no-op; read not yet safe');
        }

        const term = this.currentTerm;
        const readIndex = this.commitIndex;

        const confirmed = await this._confirmLeadership();
        if (!confirmed || this.currentTerm !== term || !this.isLeader()) {
            throw new Error('Leadership lost while confirming a read');
        }

        // Apply is synchronous on commit, so this holds immediately. The check
        // stays because it is the actual precondition, and a future change to
        // asynchronous apply would otherwise break linearizability silently.
        if (this.lastApplied < readIndex) {
            throw new Error(`Not yet applied to the read index (${this.lastApplied} < ${readIndex})`);
        }

        return fn(this.stateMachine);
    }

    /** One heartbeat round; true if a majority acknowledged this term. */
    async _confirmLeadership() {
        if (this.quorumSize === 1) return this.isLeader();

        const term = this.currentTerm;
        const results = await Promise.allSettled(this.peers.map(async (peerUrl) => {
            const next = Math.max(0, Math.min(this.nextIndex[peerUrl] ?? this.log.length, this.log.length));
            const prevLogIndex = next - 1;
            const response = await this.transport.post(`${peerUrl}/append-entries`, {
                term,
                leaderId: this.replicaId,
                leaderUrl: this.nodeUrl,
                prevLogIndex,
                prevLogTerm: prevLogIndex >= 0 ? this.log[prevLogIndex].term : 0,
                entries: [],
                leaderCommit: this.commitIndex,
            }, { timeout: 450 });

            if (response.data.term > this.currentTerm) {
                this._becomeFollower(response.data.term);
                return false;
            }
            // A rejected consistency check still proves the peer accepts this
            // node as leader for this term, which is all a read needs.
            return response.data.term === term;
        }));

        const acks = 1 + results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
        if (acks >= this.quorumSize) this.lastQuorumContactAt = this._clock.now();
        return acks >= this.quorumSize;
    }
}

module.exports = { RaftNode, StableStateStore, STATES, REAL_CLOCK };
