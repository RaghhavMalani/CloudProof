/**
 * cluster.js — a whole Raft cluster inside one process, under virtual time.
 *
 * The nodes here are the real `RaftNode`, applying into the real
 * `StateMachine`, with the real commit rule and the real persistence path. Only
 * the clock and the network are substituted. That distinction matters: a
 * simulation that reimplements the protocol tests the reimplementation.
 */

const { RaftNode } = require('../replica/raft');
const { StateMachine } = require('../replica/state-machine');
const { VirtualClock, SimNetwork } = require('./simulator');
const { DecisionStreams } = require('./decision-tape');
const { FlightRecorder } = require('../packages/simulator/flight-recorder');
const { EVENT_TYPES } = require('../packages/protocol/events');

/**
 * Stable storage that survives a simulated crash but not a simulated disk loss.
 *
 * Deliberately not a no-op. If restart wiped state, a Raft implementation that
 * never persisted its vote would pass every test here — and forgetting a vote
 * across a restart is precisely how a node ends up voting twice in one term and
 * electing two leaders.
 */
class MemoryStableStore {
    constructor() { this.data = null; this.writes = 0; }
    load() { return this.data ? JSON.parse(this.data) : {}; }
    save(state) { this.data = JSON.stringify(state); this.writes += 1; }
}

class MemoryLogStore {
    constructor() { this.entries = []; this.appends = 0; this.rewrites = 0; }
    load() { return this.entries.map((e) => JSON.parse(JSON.stringify(e))); }
    append(entries) {
        this.entries.push(...entries.map((e) => JSON.parse(JSON.stringify(e))));
        this.appends += entries.length;
    }
    rewrite(entries) {
        this.entries = entries.map((e) => JSON.parse(JSON.stringify(e)));
        this.rewrites += 1;
    }
    close() {}
}

class SimCluster {
    constructor({
        size = 3,
        // How many of `size` start as voting members. The rest are spares the
        // cluster can be grown into, so membership changes are a real join
        // rather than re-enabling a node that was a member all along.
        voters = null,
        seed = 1,
        dropRate = 0,
        minLatency = 2,
        maxLatency = 25,
        electionTimeoutMin = 150,
        electionTimeoutMax = 300,
        heartbeatInterval = 40,
        recording = false,
        recorder = null,
        recorderOptions = {},
        decisionTrace = null,
        decisionStreams = null,
    } = {}) {
        this.clock = new VirtualClock();
        this.decisionStreams = decisionStreams || new DecisionStreams({
            seed, decisions: decisionTrace, clock: this.clock,
        });
        this.network = new SimNetwork(this.clock, this.decisionStreams.stream('network.fallback'), {
            dropRate,
            minLatency,
            maxLatency,
            requestDropRng: this.decisionStreams.stream('network.request-drop'),
            responseDropRng: this.decisionStreams.stream('network.response-drop'),
            requestLatencyRng: this.decisionStreams.stream('network.request-latency'),
            responseLatencyRng: this.decisionStreams.stream('network.response-latency'),
        });
        this.seed = seed;
        this.size = size;
        this.voters = voters ?? size;
        this.config = { electionTimeoutMin, electionTimeoutMax, heartbeatInterval };

        this.urls = Array.from({ length: size }, (_, i) => `http://node${i}:5000`);
        // Storage is created once and reused across restarts, so a crashed node
        // comes back with exactly what it had durably written.
        this.stores = this.urls.map(() => ({ stable: new MemoryStableStore(), log: new MemoryLogStore() }));
        this.nodes = new Map();
        this.recorder = recorder || (recording
            ? new FlightRecorder({ clock: this.clock, seed, ...recorderOptions })
            : null);
        if (this.recorder) this.recorder.attachNetwork(this.network);

        for (let i = 0; i < size; i += 1) this._spawn(i);
        if (this.recorder) this.recorder.captureCluster(this);
    }

    _spawn(index) {
        const electionRng = this.decisionStreams.stream('election.node' + index);
        const timeoutOffset = electionRng.int(40, 'node-timeout-offset-ms', { node: index });

        const url = this.urls[index];
        const node = new RaftNode({
            replicaId: `node${index}`,
            nodeUrl: url,
            // Every node bootstraps with the *initial* voter set, spares
            // included. A spare therefore boots knowing it is not a member and
            // will not campaign; it learns its promotion from the log when the
            // leader replicates the config entry that adds it.
            members: this.urls.slice(0, this.voters),
            // Bound to this node's URL so the network can tell who is sending
            // and apply partitions to vote requests as well as replication.
            transport: this.network.forNode(url),
            clock: this.clock,
            // Election jitter comes from the seeded PRNG, not Math.random.
            // Without this the schedule differs on every run and the whole
            // "reproducible from a seed" property is a fiction.
            randomElectionTimeout: (min, max) => electionRng.range(
                min, Math.max(min, max - 1), 'election-timeout-ms', { node: index },
            ),
            stableStore: this.stores[index].stable,
            logStore: this.stores[index].log,
            storagePath: false,
            stateMachine: new StateMachine(),
            autoStart: true,
            commitTimeoutMs: 1500,
            ...this.config,
            electionTimeoutMin: this.config.electionTimeoutMin + timeoutOffset,
        });

        this.network.register(url, {
            '/pre-vote': (body) => node.handlePreVote(body),
            '/request-vote': (body) => node.handleRequestVote(body),
            '/append-entries': (body) => node.handleAppendEntries(body),
        });

        this.nodes.set(url, node);
        return node;
    }

    /**
     * The leader a client should talk to.
     *
     * Naively returning the first node that believes it leads is wrong during a
     * partition, and wrong in the most misleading way: a leader cut off from
     * the majority does not know it yet, so it keeps reporting LEADER until its
     * next contact with a higher term. A client following that answer sends
     * every write into a node that cannot commit anything.
     *
     * Picking the highest term matches what a real client learns from redirects,
     * and it is why `leaders` below exists separately — the visualisation wants
     * to show *both* claimants, because two nodes simultaneously believing they
     * lead is the single most instructive thing this system does.
     */
    get leader() {
        let best = null;
        for (const [url, node] of this.nodes) {
            if (!node.isLeader() || this.network.crashed.has(url)) continue;
            if (!best || node.currentTerm > best.node.currentTerm) best = { url, node };
        }
        return best;
    }

    /** Every node that currently believes it is leader. Usually one. */
    get leaders() {
        return [...this.nodes.entries()]
            .filter(([url, node]) => node.isLeader() && !this.network.crashed.has(url))
            .map(([url, node]) => ({ url, node, term: node.currentTerm }));
    }

    /** Advances virtual time until a leader exists, or gives up. */
    async awaitLeader(maxMs = 5000) {
        const deadline = this.clock.now() + maxMs;
        while (this.clock.now() < deadline) {
            if (this.leader) return this.leader;
            if (!this.clock.advance()) break;
            // Without this the vote responses never get processed — see
            // VirtualClock#drain.
            await this.clock.drain();
        }
        return this.leader;
    }

    async tick(ms) {
        const steps = await this.clock.runFor(ms);
        if (this.recorder) this.recorder.captureCluster(this);
        return steps;
    }

    /** Pause the real-time driver and execute exactly one scheduled callback. */
    async step() {
        this.stopDriver();
        const advanced = this.clock.advance();
        if (advanced) await this.clock.drain();
        if (this.recorder) this.recorder.captureCluster(this);
        return advanced;
    }

    /**
     * Drives virtual time continuously, pegged to real time.
     *
     * The fuzzer wants virtual time to run as fast as the CPU allows — that is
     * the entire point of it. An interactive demo wants the opposite: elections
     * and heartbeats should unfold at human speed so they can be watched.
     * `speed` scales the two against each other, so the same cluster serves
     * both a 2000x fuzz campaign and a 1x visualisation.
     *
     * Without a driver like this the cluster is frozen: a client call awaits a
     * commit that needs a timer that nobody is firing, and it simply never
     * returns. That is a deadlock, not a bug in the engine — virtual time only
     * moves when something moves it.
     */
    start({ speed = 1, intervalMs = 50, onTick = null, keepAlive = true } = {}) {
        if (this._driver) return;
        this._driver = setInterval(async () => {
            if (this._driving) return;      // never re-enter mid-advance
            this._driving = true;
            try {
                await this.clock.runFor(intervalMs * speed);
                if (this.recorder) this.recorder.captureCluster(this);
                if (onTick) onTick(this);
            } finally {
                this._driving = false;
            }
        }, intervalMs);
        // Held by default. An unref'd driver lets Node exit while a caller is
        // still awaiting a commit that only this driver can deliver — the
        // process simply vanishes mid-await with no error, which is a
        // spectacularly confusing thing to debug.
        if (!keepAlive && this._driver.unref) this._driver.unref();
    }

    stopDriver() {
        if (this._driver) clearInterval(this._driver);
        this._driver = null;
    }

    // ── fault injection ──────────────────────────────────────────────────────

    /** Splits the cluster. `groups` is an array of arrays of node indexes. */
    partition(groups) {
        this.network.partition(groups.map((g) => g.map((i) => this.urls[i])));
        this.recorder?.record(EVENT_TYPES.FAULT_APPLIED, {
            source: { component: 'fault-injector' }, subject: { kind: 'network' },
            data: { fault: 'partition', groups },
        });
        this.recorder?.captureCluster(this);
    }

    /** Isolates one node from the rest — the common minority-partition case. */
    isolate(index) {
        const others = this.urls.filter((_, i) => i !== index);
        this.network.partition([[this.urls[index]], others]);
        this.recorder?.record(EVENT_TYPES.FAULT_APPLIED, {
            source: { component: 'fault-injector' }, subject: { kind: 'node', id: `node${index}` },
            data: { fault: 'isolate', index },
        });
        this.recorder?.captureCluster(this);
    }

    heal() {
        this.network.heal();
        this.recorder?.record(EVENT_TYPES.FAULT_HEALED, {
            source: { component: 'fault-injector' }, subject: { kind: 'network' },
            data: { fault: 'all-network-faults' },
        });
        this.recorder?.captureCluster(this);
    }

    /**
     * Hard crash: the process disappears. Timers stop, in-memory state is
     * gone, durable state remains.
     */
    crash(index) {
        const url = this.urls[index];
        const node = this.nodes.get(url);
        if (node) node.stop();
        this.network.crash(url);
        this.nodes.delete(url);
        this.recorder?.record(EVENT_TYPES.FAULT_APPLIED, {
            source: { component: 'fault-injector' }, subject: { kind: 'node', id: `node${index}` },
            data: { fault: 'crash', index },
        });
        this.recorder?.captureCluster(this);
    }

    /** Restart from durable state only, exactly as a real process would. */
    restart(index) {
        this.network.restart(this.urls[index]);
        const node = this._spawn(index);
        this.recorder?.record(EVENT_TYPES.FAULT_HEALED, {
            source: { component: 'fault-injector' }, subject: { kind: 'node', id: `node${index}` },
            data: { fault: 'crash', index },
        });
        this.recorder?.captureCluster(this);
        return node;
    }

    /**
     * Adds a spare node to the cluster through the leader.
     *
     * The spare is spawned first so it can actually answer AppendEntries while
     * it is catching up — a configuration naming a server that does not exist
     * would stall the join for reasons that have nothing to do with the
     * protocol.
     */
    async addMember(index, options = {}) {
        const leader = this.leader;
        if (!leader) return { ok: false, error: 'no leader' };
        const url = this.urls[index];
        if (!this.nodes.has(url)) this._spawn(index);
        this.network.restart(url);
        return leader.node.addServer(url, { catchUpTimeoutMs: 4000, ...options });
    }

    async removeMember(index) {
        const leader = this.leader;
        if (!leader) return { ok: false, error: 'no leader' };
        return leader.node.removeServer(this.urls[index]);
    }

    /**
     * Every configuration this cluster has ever committed, oldest first.
     *
     * Read out of the leader's log rather than tracked separately, so the
     * invariant below is checked against what was actually replicated instead
     * of against the harness's idea of what happened.
     */
    configurationHistory() {
        const source = this.leader?.node ?? [...this.nodes.values()][0];
        if (!source) return [];
        const history = [source.bootstrapMembers];
        for (const entry of source.log) {
            if (entry.data && entry.data.op === 'config') history.push(entry.data.members);
        }
        return history;
    }

    /**
     * The safety property single-server changes exist to provide.
     *
     * Any majority of one configuration must intersect any majority of the
     * next. If they can be disjoint, two leaders can be elected simultaneously
     * — one by each half — and the cluster splits with no way to detect it
     * from the outside.
     */
    checkConfigurationOverlap() {
        const history = this.configurationHistory();
        for (let i = 1; i < history.length; i += 1) {
            const before = history[i - 1];
            const after = history[i];
            const shared = after.filter((u) => before.includes(u)).length;
            const majorityBefore = Math.floor(before.length / 2) + 1;
            const majorityAfter = Math.floor(after.length / 2) + 1;
            // Two majorities must overlap unless they can fit disjointly into
            // the union of both configurations.
            if (majorityBefore + majorityAfter <= before.length + after.length - shared) {
                return {
                    ok: false,
                    reason: `configurations ${i - 1}->${i} admit disjoint majorities: `
                        + `[${before.join(',')}] -> [${after.join(',')}]`,
                };
            }
        }
        return { ok: true, changes: history.length - 1 };
    }

    /** Portable random-decision artifact for exact replay and shrinking. */
    exportDecisionTrace() {
        return this.decisionStreams.export();
    }

    decisionDiagnostics() {
        return this.decisionStreams.diagnostics();
    }

    /** Every live node's applied state, for the convergence assertion. */
    states() {
        return [...this.nodes.entries()]
            .filter(([url]) => !this.network.crashed.has(url))
            .map(([url, node]) => ({
                url,
                replicaId: node.replicaId,
                term: node.currentTerm,
                state: node.state,
                logLength: node.log.length,
                commitIndex: node.commitIndex,
                keys: node.stateMachine.list().map((k) => `${k.key}=${JSON.stringify(k.value)}`).join('|'),
                index: node.stateMachine.index ? node.stateMachine.index.fingerprint() : null,
            }));
    }

    /**
     * The safety property that matters most, checked directly on internal
     * state rather than inferred from responses: no two nodes may hold
     * different entries at the same log index. A violation here means the
     * protocol is broken, regardless of what any client observed.
     */
    /**
     * The Log Matching Property (Raft §5.3): if two logs contain an entry at
     * the same index *and the same term*, then every preceding entry is
     * identical.
     *
     * ── What this deliberately does not check ────────────────────────────────
     * An earlier version asserted that no two replicas may differ at any index
     * at all. That is a stronger claim than Raft makes, and it is false: a
     * leader that is deposed with entries still uncommitted keeps them until
     * the new leader overwrites them, so two logs legitimately disagree on
     * their uncommitted tails. It passed a thousand seeds only because those
     * schedules happened to end in a converged state; adding membership churn
     * produced exactly the transient divergence Raft allows, and the harness
     * reported thirteen "failures" in code that was behaving correctly.
     *
     * Committed entries are covered separately by checkCommittedPrefix, which
     * is where the real safety burden belongs.
     */
    checkLogConsistency() {
        const live = [...this.nodes.values()];
        for (let i = 0; i < live.length; i += 1) {
            for (let j = i + 1; j < live.length; j += 1) {
                const a = live[i].log;
                const b = live[j].log;
                const shared = Math.min(a.length, b.length);

                // The deepest index where both agree on the term. Log Matching
                // says everything below it must be byte-identical.
                let deepestMatch = -1;
                for (let k = shared - 1; k >= 0; k -= 1) {
                    if (a[k].term === b[k].term) { deepestMatch = k; break; }
                }

                for (let k = 0; k <= deepestMatch; k += 1) {
                    if (a[k].term !== b[k].term
                        || JSON.stringify(a[k].data) !== JSON.stringify(b[k].data)) {
                        return {
                            ok: false,
                            reason: `${live[i].replicaId} and ${live[j].replicaId} violate log matching: `
                                + `entries agree at index ${deepestMatch} but differ at ${k}`,
                        };
                    }
                }
            }
        }
        return { ok: true };
    }

    /** Committed prefixes must be identical — the State Machine Safety property. */
    checkCommittedPrefix() {
        const live = [...this.nodes.values()];
        const minCommit = Math.min(...live.map((n) => n.commitIndex));
        for (let k = 0; k <= minCommit; k += 1) {
            const reference = JSON.stringify(live[0].log[k]?.data);
            for (const node of live.slice(1)) {
                if (JSON.stringify(node.log[k]?.data) !== reference) {
                    return { ok: false, reason: `committed entry ${k} differs across replicas` };
                }
            }
        }
        return { ok: true, verified: minCommit + 1 };
    }

    stop() {
        this.stopDriver();
        for (const node of this.nodes.values()) node.stop();
        this.recorder?.finish({ reason: 'cluster-stopped' });
    }
}

module.exports = { SimCluster, MemoryStableStore, MemoryLogStore };
