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
const { VirtualClock, SimNetwork, Rng } = require('./simulator');

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
        seed = 1,
        dropRate = 0,
        minLatency = 2,
        maxLatency = 25,
        electionTimeoutMin = 150,
        electionTimeoutMax = 300,
        heartbeatInterval = 40,
    } = {}) {
        this.rng = new Rng(seed);
        this.clock = new VirtualClock();
        this.network = new SimNetwork(this.clock, this.rng, { dropRate, minLatency, maxLatency });
        this.seed = seed;
        this.size = size;
        this.config = { electionTimeoutMin, electionTimeoutMax, heartbeatInterval };

        this.urls = Array.from({ length: size }, (_, i) => `http://node${i}:5000`);
        // Storage is created once and reused across restarts, so a crashed node
        // comes back with exactly what it had durably written.
        this.stores = this.urls.map(() => ({ stable: new MemoryStableStore(), log: new MemoryLogStore() }));
        this.nodes = new Map();

        for (let i = 0; i < size; i += 1) this._spawn(i);
    }

    _spawn(index) {
        const url = this.urls[index];
        const node = new RaftNode({
            replicaId: `node${index}`,
            peers: this.urls.filter((u) => u !== url),
            nodeUrl: url,
            // Bound to this node's URL so the network can tell who is sending
            // and apply partitions to vote requests as well as replication.
            transport: this.network.forNode(url),
            clock: this.clock,
            stableStore: this.stores[index].stable,
            logStore: this.stores[index].log,
            storagePath: false,
            stateMachine: new StateMachine(),
            autoStart: true,
            commitTimeoutMs: 1500,
            ...this.config,
        });

        // Randomising the initial election timer per node is what stops all
        // three from campaigning simultaneously forever. With a virtual clock
        // and no jitter, a symmetric cluster can livelock in split votes — the
        // real world gets this for free from scheduling noise.
        node.electionTimeoutMin = this.config.electionTimeoutMin + this.rng.int(40);

        this.network.register(url, {
            '/request-vote': (body) => node.handleRequestVote(body),
            '/append-entries': (body) => node.handleAppendEntries(body),
        });

        this.nodes.set(url, node);
        return node;
    }

    get leader() {
        for (const [url, node] of this.nodes) {
            if (node.isLeader() && !this.network.crashed.has(url)) return { url, node };
        }
        return null;
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

    tick(ms) { return this.clock.runFor(ms); }

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
    }

    /** Isolates one node from the rest — the common minority-partition case. */
    isolate(index) {
        const others = this.urls.filter((_, i) => i !== index);
        this.network.partition([[this.urls[index]], others]);
    }

    heal() { this.network.heal(); }

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
    }

    /** Restart from durable state only, exactly as a real process would. */
    restart(index) {
        this.network.restart(this.urls[index]);
        return this._spawn(index);
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
    checkLogConsistency() {
        const live = [...this.nodes.values()];
        for (let i = 0; i < live.length; i += 1) {
            for (let j = i + 1; j < live.length; j += 1) {
                const a = live[i].log;
                const b = live[j].log;
                const shared = Math.min(a.length, b.length);
                for (let k = 0; k < shared; k += 1) {
                    if (a[k].term !== b[k].term) {
                        return {
                            ok: false,
                            reason: `${live[i].replicaId} and ${live[j].replicaId} disagree at index ${k}: `
                                + `term ${a[k].term} vs ${b[k].term}`,
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
    }
}

module.exports = { SimCluster, MemoryStableStore, MemoryLogStore };
