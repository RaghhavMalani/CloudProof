/**
 * simulator.js — a deterministic virtual world for the cluster.
 *
 * ── Why simulate instead of injecting faults into a real network ─────────────
 * The usual way to test a consensus implementation is to run it for real and
 * break things: `tc netem` for packet loss, `iptables` for partitions, SIGKILL
 * for crashes. It works, and it finds bugs. It also has two properties that
 * make it a poor primary defence:
 *
 *   it is slow      a partition has to last long enough for a real election
 *                   timeout, so exploring a thousand fault schedules takes
 *                   hours of wall time
 *   it is not reproducible
 *                   a failure depends on the exact interleaving of real
 *                   threads and real packets. You see the assertion fire once
 *                   and then never again, which means you cannot debug it —
 *                   only stare at it
 *
 * Here, time is virtual and every random choice comes from a seeded PRNG. The
 * consequence is the one that matters: **a run is a pure function of its seed**.
 * A thousand-operation run under partitions completes in milliseconds, and when
 * one fails you replay that exact seed under a debugger and watch it fail the
 * same way, forever.
 *
 * This is what FoundationDB built before they built the database, and what
 * TigerBeetle and Antithesis do now. It is the difference between "I tested it"
 * and "I searched the schedule space".
 *
 * Nothing here is a mock of the system under test. The real RaftNode, the real
 * HNSW index, the real state machine and the real commit rules all run
 * unmodified — only the clock and the wire are virtual.
 */

/** xorshift128. Seeded, integer-only, identical on every platform. */
class Rng {
    constructor(seed = 1) {
        this.x = (seed >>> 0) || 1;
        this.y = 362436069; this.z = 521288629; this.w = 88675123;
    }

    next() {
        const t = (this.x ^ (this.x << 11)) >>> 0;
        this.x = this.y; this.y = this.z; this.z = this.w;
        this.w = ((this.w ^ (this.w >>> 19)) ^ (t ^ (t >>> 8))) >>> 0;
        return this.w;
    }

    float() { return this.next() / 4294967296; }
    int(maxExclusive) { return this.next() % maxExclusive; }
    range(min, max) { return min + this.int(Math.max(1, max - min + 1)); }
    pick(array) { return array[this.int(array.length)]; }
    chance(probability) { return this.float() < probability; }
}

/**
 * Virtual time.
 *
 * A priority queue of callbacks keyed by their due time. `advance` pops the
 * earliest, jumps the clock straight to it, and runs it — so a 500ms election
 * timeout costs nothing at all. Sequence numbers break ties so two callbacks
 * scheduled for the same instant always run in the order they were registered,
 * which is what keeps the whole run reproducible.
 */
class VirtualClock {
    constructor(startAt = 1_700_000_000_000) {
        this.time = startAt;
        this.queue = [];
        this.sequence = 0;
        this.handles = new Map();
        this.fired = 0;
        this.compactions = 0;
    }

    now() { return this.time; }

    _schedule(fn, delayMs, repeatMs = null) {
        const handle = ++this.sequence;
        const task = {
            handle,
            at: this.time + Math.max(0, delayMs),
            sequence: handle,
            fn,
            repeatMs,
            cancelled: false,
        };
        this.handles.set(handle, task);
        this.queue.push(task);
        return handle;
    }

    setTimeout(fn, ms) { return this._schedule(fn, ms); }
    setInterval(fn, ms) { return this._schedule(fn, ms, ms); }

    clearTimeout(handle) {
        const task = this.handles.get(handle);
        if (task) { task.cancelled = true; this.handles.delete(handle); }
    }

    clearInterval(handle) { this.clearTimeout(handle); }

    /** Runs the next due callback. Returns false when nothing is left. */
    advance() {
        // Linear scan rather than a heap: the queue holds tens of entries, and
        // a scan with an explicit total order is easier to keep deterministic
        // than a heap whose sift order depends on insertion history.
        // Compact first, then scan.
        //
        // Cancelled tasks were being skipped but never removed, so the queue
        // grew without bound — Raft cancels and recreates its election timer on
        // every heartbeat, several times a second per node. Left alone this
        // scan degrades from O(live) to O(everything ever scheduled), and a long
        // run slows to a crawl for reasons that look like a protocol bug rather
        // than a harness one.
        //
        // Compacting *after* choosing `best` is worse than not compacting at
        // all: the index refers to the pre-filter array and points at the wrong
        // task, or past the end.
        if (this.queue.length > 64) {
            const live = this.queue.filter((task) => !task.cancelled);
            if (live.length < this.queue.length / 2) {
                this.queue = live;
                this.compactions += 1;
            }
        }

        let best = -1;
        for (let i = 0; i < this.queue.length; i += 1) {
            const task = this.queue[i];
            if (task.cancelled) continue;
            if (best === -1
                || task.at < this.queue[best].at
                || (task.at === this.queue[best].at && task.sequence < this.queue[best].sequence)) {
                best = i;
            }
        }

        if (best === -1) { this.queue = []; return false; }

        const task = this.queue[best];
        this.queue.splice(best, 1);
        this.time = Math.max(this.time, task.at);
        this.fired += 1;

        if (task.repeatMs !== null && !task.cancelled) {
            task.at = this.time + task.repeatMs;
            task.sequence = ++this.sequence;
            this.queue.push(task);
        } else {
            this.handles.delete(task.handle);
        }

        task.fn();
        return true;
    }

    /**
     * Yields to the host so pending promise callbacks actually run.
     *
     * This is the subtle part of driving async code under a virtual clock, and
     * getting it wrong produces a spectacular and confusing failure. Firing a
     * timer resolves a promise, but the `.then` handler is a *microtask* — it
     * does not run until the current synchronous execution yields. A tight
     * `while (clock.advance())` loop never yields, so vote responses are never
     * processed while election timers keep firing, and the cluster campaigns
     * forever at ever-increasing terms without electing anybody.
     *
     * `setImmediate` drains both the microtask queue and the macrotask queue,
     * which is what makes the simulated cluster behave like a real one.
     */
    drain() {
        return new Promise((resolve) => setImmediate(resolve));
    }

    /** Runs until `untilMs` of virtual time has elapsed or the queue drains. */
    async runFor(untilMs) {
        const deadline = this.time + untilMs;
        let steps = 0;
        while (this.time < deadline) {
            const pending = this.queue.some((t) => !t.cancelled && t.at <= deadline);
            if (!pending) { this.time = deadline; break; }
            if (!this.advance()) break;
            await this.drain();
            steps += 1;
            if (steps > 500_000) throw new Error('simulation did not converge');
        }
        return steps;
    }
}

/**
 * A network that can be broken.
 *
 * Presents the same `post(url, body, options)` surface the RaftNode already
 * expects from axios, so the engine cannot tell the difference. Every message
 * is delayed by a sampled latency and delivered through the virtual clock,
 * which is what lets partitions and reordering emerge naturally rather than
 * being special-cased.
 */
class SimNetwork {
    constructor(clock, rng, options = {}) {
        this.clock = clock;
        this.rng = rng;
        this.minLatency = options.minLatency ?? 2;
        this.maxLatency = options.maxLatency ?? 25;
        this.dropRate = options.dropRate ?? 0;
        this.handlers = new Map();   // nodeUrl -> { '/append-entries': fn, ... }
        this.partitions = [];        // array of Sets; nodes in different sets cannot talk
        this.crashed = new Set();
        this.stats = { sent: 0, delivered: 0, dropped: 0, partitioned: 0 };
    }

    register(url, handlers) { this.handlers.set(url, handlers); }

    /** True when `a` and `b` are on opposite sides of any active partition. */
    _isolated(a, b) {
        if (this.partitions.length === 0) return false;
        const sideOf = (url) => this.partitions.findIndex((group) => group.has(url));
        const sa = sideOf(a);
        const sb = sideOf(b);
        // A node in no group is reachable from everyone — this models a
        // minority being cut off rather than the network shattering entirely.
        if (sa === -1 || sb === -1) return false;
        return sa !== sb;
    }

    partition(groups) { this.partitions = groups.map((g) => new Set(g)); }
    heal() { this.partitions = []; }
    crash(url) { this.crashed.add(url); }
    restart(url) { this.crashed.delete(url); }

    /**
     * A transport bound to one node, so the network knows who is sending.
     *
     * The first version inferred the sender from the message body — `leaderUrl`
     * on AppendEntries, `candidateId` on RequestVote. That silently half-worked
     * and produced a false positive that looked like a serious Raft bug:
     * `candidateId` is a replica *id* (`node0`), not a URL, so it never matched
     * a partition group and **vote requests crossed partitions freely**. An
     * isolated node could therefore win an election, become a second leader, and
     * commit divergent entries — a textbook split brain, caused entirely by the
     * harness.
     *
     * Worth the scar tissue: a fault injector that is wrong in the permissive
     * direction invents failures, and a day spent debugging correct code is the
     * most expensive kind of day.
     */
    forNode(url) {
        return { post: (target, body, options) => this.post(target, body, options, url) };
    }

    post(url, body, options = {}, sender = null) {
        this.stats.sent += 1;
        const target = new URL(url).origin;
        const route = new URL(url).pathname;
        const from = sender || body.leaderUrl || 'client';

        return new Promise((resolve, reject) => {
            const fail = (reason) => {
                // Delivered as a rejection after the timeout elapses, exactly
                // as a real socket would behave — a dropped packet is not an
                // instant error, it is silence until something gives up. Getting
                // this wrong makes elections converge unrealistically fast.
                this.clock.setTimeout(
                    () => reject(new Error(reason)),
                    options.timeout ?? 400,
                );
            };

            if (this.crashed.has(target)) return fail('ECONNREFUSED');
            if (this._isolated(from, target)) {
                this.stats.partitioned += 1;
                return fail('EHOSTUNREACH');
            }
            if (this.rng.chance(this.dropRate)) {
                this.stats.dropped += 1;
                return fail('ETIMEDOUT');
            }

            const latency = this.rng.range(this.minLatency, this.maxLatency);
            this.clock.setTimeout(() => {
                const node = this.handlers.get(target);
                if (!node || this.crashed.has(target)) return reject(new Error('ECONNREFUSED'));
                const handler = node[route];
                if (!handler) return reject(new Error('404'));

                let data;
                try { data = handler(body); } catch (error) { return reject(error); }

                // The reply takes its own trip back, and can be lost on the way.
                // A response dropped after the request was applied is the case
                // that produces "the write succeeded but the client saw a
                // timeout" — precisely the ambiguity the linearizability checker
                // has to reason about.
                if (this.rng.chance(this.dropRate)) {
                    this.stats.dropped += 1;
                    return fail('ETIMEDOUT');
                }
                const back = this.rng.range(this.minLatency, this.maxLatency);
                this.clock.setTimeout(() => {
                    this.stats.delivered += 1;
                    resolve({ data });
                }, back);
            }, latency);
        });
    }
}

module.exports = { Rng, VirtualClock, SimNetwork };
