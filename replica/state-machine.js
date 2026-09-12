/**
 * state-machine.js — the deterministic keyspace that committed Raft entries
 * are applied into.
 *
 * Everything in here must be a pure function of (current state, entry). No
 * Date.now(), no Math.random(), no I/O. If two replicas apply the same
 * committed prefix they must land in byte-identical states, otherwise a leader
 * change silently changes the answer to a read.
 *
 * ── Why leases need a logical clock ──────────────────────────────────────────
 * A lease is only useful if it expires, and expiry is the one place where a
 * naive implementation reaches for wall-clock time. It cannot: replica A might
 * evaluate `Date.now() > expiresAt` a few milliseconds either side of replica
 * B, and the two state machines diverge — one thinks a shard is owned, the
 * other thinks it is free, and the control plane double-assigns it.
 *
 * Instead, the leader stamps every entry it appends with its own wall clock in
 * `entry.ts`, and the state machine keeps a monotonic `clock` equal to the
 * highest stamp it has ever applied. Expiry is evaluated against that clock.
 * Every replica sees the same stamps in the same order, so every replica
 * expires the same lease at the same log index. Time becomes just another
 * value that goes through consensus.
 *
 * The cost is that the clock only advances when something is appended, so a
 * cluster with no traffic never expires anything. The leader therefore appends
 * a `tick` entry while any lease is outstanding — see RaftNode#_startLeaseTicks.
 * Ticks are cheap, bounded by the tick interval, and stop entirely once the
 * last lease is gone.
 */

const { HnswIndex } = require('./hnsw');
const { BM25Index, reciprocalRankFusion } = require('./sparse');
const { AgentState } = require('./agent-state');

const EVENT_BUFFER_LIMIT = 1024;
const RESULT_CACHE_LIMIT = 4096;

/**
 * Vectors travel through the log as base64 of the raw Float32Array buffer, not
 * as JSON arrays of numbers.
 *
 * A 384-dimensional embedding serialises to roughly 7.7KB as JSON and 2KB as
 * base64 — and every log entry is fsync'd, so that factor of four lands
 * directly on write latency, on disk footprint, and on how long a restarted
 * node takes to replay. Base64 of the underlying bytes is also exact, whereas
 * JSON numbers round-trip through decimal.
 */
// Base64 without Buffer, so this module loads in a browser as well as in Node.
// The state machine is the one part that genuinely has to run in both: the
// interactive demo executes this exact code client-side.
const HAS_BUFFER = typeof Buffer !== 'undefined';

function bytesToBase64(bytes) {
    if (HAS_BUFFER) return Buffer.from(bytes).toString('base64');
    let binary = '';
    // Chunked to stay under the argument-count limit on large vectors; passing
    // 1536 bytes as individual arguments works, but a bigger index would blow
    // the stack in a way that only shows up in production.
    for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
}

function base64ToBytes(text) {
    if (HAS_BUFFER) return new Uint8Array(Buffer.from(text, 'base64'));
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
}

function encodeVector(vector) {
    const typed = vector instanceof Float32Array ? vector : Float32Array.from(vector);
    return bytesToBase64(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength));
}

function decodeVector(encoded) {
    if (encoded instanceof Float32Array) return encoded;
    if (Array.isArray(encoded)) return Float32Array.from(encoded);
    const bytes = base64ToBytes(encoded);
    // Copy rather than view: the source may not be 4-byte aligned, and a
    // Float32Array over a misaligned offset throws.
    const out = new Float32Array(bytes.byteLength / 4);
    new Uint8Array(out.buffer).set(bytes);
    return out;
}

class StateMachine {
    constructor() {
        /** @type {Map<string, {value: any, rev: number, createRev: number, lease: string|null}>} */
        this.store = new Map();
        /** @type {Map<string, {holder: string, ttlMs: number, expiresAt: number, rev: number}>} */
        this.leases = new Map();

        // Logical time, in milliseconds, sourced entirely from leader stamps.
        this.clock = 0;
        // Monotonic revision, bumped once per mutation. This is what watchers
        // resume from and what CAS compares against.
        this.revision = 0;
        this.lastAppliedIndex = -1;

        /**
         * The vector index — the actual state machine, in the Raft sense.
         *
         * Raft is explicit that the consensus layer knows nothing about what it
         * replicates. Swapping the whiteboard's stroke list for an HNSW graph
         * required no change to raft.js at all, which is the clearest possible
         * demonstration of that separation: same log, same commit rule, same
         * elections, entirely different database.
         *
         * Created by an `index-create` entry rather than by constructor
         * arguments, so its dimensionality and — critically — its PRNG seed are
         * agreed through consensus. A seed passed in locally could differ per
         * replica and the graphs would silently diverge.
         */
        this.index = null;
        this.indexConfig = null;
        /**
         * The lexical half of hybrid retrieval, replicated alongside the dense
         * index and from the same log entries. Both are rebuilt by the same
         * boot replay, so a restarted node cannot come back with one populated
         * and the other empty.
         */
        this.sparse = new BM25Index();

        // AgentExecution and EffectLedger live here, not in a side database.
        // Their only mutation path is AgentState#apply from committed log
        // entries, so boot replay reconstructs them with the keyspace/index.
        this.agent = new AgentState();

        this.events = [];
        this.eventsDropped = 0;
        this._results = new Map();
        this._listeners = new Set();
    }

    get activeLeaseCount() {
        return this.leases.size;
    }

    // ── read path ────────────────────────────────────────────────────────────

    get(key) {
        const record = this.store.get(key);
        if (!record) return null;
        return { key, ...record };
    }

    list(prefix = '') {
        const out = [];
        for (const [key, record] of this.store) {
            if (key.startsWith(prefix)) out.push({ key, ...record });
        }
        return out.sort((a, b) => (a.key < b.key ? -1 : 1));
    }

    /**
     * Leases are reported against the logical clock, so a caller asking "is
     * this lease live?" gets the same answer on every replica.
     */
    leaseInfo(key) {
        const lease = this.leases.get(key);
        if (!lease) return null;
        return { key, ...lease, remainingMs: Math.max(0, lease.expiresAt - this.clock) };
    }

    eventsSince(revision, { prefix = '' } = {}) {
        return this.events.filter(
            (event) => event.rev > revision && event.key.startsWith(prefix),
        );
    }

    resultFor(index) {
        return this._results.get(index) ?? null;
    }

    agentExecution(executionId) {
        return this.agent.get(executionId);
    }

    agentExecutions() {
        return this.agent.list();
    }

    agentResource(resourceId) {
        return this.agent.getResource(resourceId);
    }

    agentResources() {
        return this.agent.listResources();
    }

    // ── event plumbing ───────────────────────────────────────────────────────

    subscribe(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    _emit(event) {
        this.events.push(event);
        if (this.events.length > EVENT_BUFFER_LIMIT) {
            this.events.splice(0, this.events.length - EVENT_BUFFER_LIMIT);
            this.eventsDropped += 1;
        }
        // Listeners are notified outside the deterministic core: they observe
        // state, they never influence it.
        for (const listener of this._listeners) {
            try {
                listener(event);
            } catch (error) {
                console.error(`[state-machine] watcher threw: ${error.message}`);
            }
        }
    }

    _rememberResult(index, result) {
        if (index == null) return result;
        this._results.set(index, result);
        if (this._results.size > RESULT_CACHE_LIMIT) {
            const oldest = this._results.keys().next().value;
            this._results.delete(oldest);
        }
        return result;
    }

    // ── apply ────────────────────────────────────────────────────────────────

    /**
     * Applies one committed entry. Returns the command result, which the leader
     * hands back to the waiting client. Safe to call during boot replay.
     */
    apply(entry) {
        if (!entry) return { ok: false, error: 'empty entry' };

        // Monotonic: a stale stamp from a deposed leader must never rewind time.
        if (Number.isFinite(entry.ts) && entry.ts > this.clock) this.clock = entry.ts;
        this.lastAppliedIndex = entry.index;

        this._expireLeases(entry.index);

        const command = entry.data || {};
        const op = command.op || 'append';

        let result;
        switch (op) {
            case 'tick':
                result = { ok: true, clock: this.clock };
                break;
            case 'config':
                // Membership is a Raft-level concern, handled by
                // RaftNode#_refreshConfiguration when the entry is appended.
                // The state machine records it as applied and changes nothing.
                result = { ok: true, config: true, members: command.members };
                break;
            case 'noop':
                // The Raft §8 term marker. It exists to move commitIndex, not
                // to change state, so applying it must do nothing at all.
                result = { ok: true, noop: true };
                break;
            case 'set':
                result = this._applySet(command, entry);
                break;
            case 'delete':
                result = this._applyDelete(command, entry);
                break;
            case 'cas':
                result = this._applyCas(command, entry);
                break;
            case 'lease-acquire':
                result = this._applyLeaseAcquire(command, entry);
                break;
            case 'lease-renew':
                result = this._applyLeaseRenew(command, entry);
                break;
            case 'lease-release':
                result = this._applyLeaseRelease(command, entry);
                break;
            case 'index-create':
                result = this._applyIndexCreate(command);
                break;
            case 'vector-upsert':
                result = this._applyVectorUpsert(command, entry);
                break;
            case 'vector-delete':
                result = this._applyVectorDelete(command, entry);
                break;
            case 'agent.execution.create':
            case 'agent.execution.advance':
            case 'agent.execution.complete':
            case 'agent.execution.plan':
            case 'agent.resource.create':
            case 'agent.effect.authorize-resource':
            case 'agent.effect.intent':
            case 'agent.effect.dispatch':
            case 'agent.effect.reconciliation-required':
            case 'agent.effect.result':
            case 'agent.effect.commit':
            case 'agent.semantic-conflict.detect':
            case 'agent.snapshot.transition':
                result = this._applyAgent(command, entry);
                break;
            case 'append':
                // Legacy path: the whiteboard appends opaque strokes with no
                // key. They are ordered and durable but not addressable.
                result = { ok: true, opaque: true };
                break;
            default:
                result = { ok: false, error: `unknown op: ${op}` };
        }

        return this._rememberResult(entry.index, result);
    }

    _applyAgent(command, entry) {
        const outcome = this.agent.apply(command, { index: entry.index });
        const { mutated, ...result } = outcome;
        if (!mutated) return result;

        this.revision += 1;
        const isResource = command.op === 'agent.resource.create';
        const subjectId = isResource ? command.resourceId : command.executionId;
        this._emit({
            type: command.op,
            key: isResource ? `agent/resource/${subjectId}` : `agent/execution/${subjectId}`,
            value: isResource
                ? this.agent.getResource(subjectId)
                : this.agent.get(subjectId),
            rev: this.revision,
            index: entry.index,
            clock: this.clock,
        });
        return { ...result, rev: this.revision };
    }

    _expireLeases(index) {
        for (const [key, lease] of [...this.leases]) {
            if (lease.expiresAt > this.clock) continue;
            this.leases.delete(key);
            this.store.delete(key);
            this.revision += 1;
            this._emit({
                type: 'lease-expired',
                key,
                holder: lease.holder,
                value: null,
                rev: this.revision,
                index,
                clock: this.clock,
            });
        }
    }

    _put(key, value, entry, { lease = null, type = 'put' } = {}) {
        const existing = this.store.get(key);
        this.revision += 1;
        const record = {
            value,
            rev: this.revision,
            createRev: existing ? existing.createRev : this.revision,
            lease,
        };
        this.store.set(key, record);
        this._emit({
            type,
            key,
            value,
            rev: this.revision,
            createRev: record.createRev,
            index: entry.index,
            clock: this.clock,
        });
        return record;
    }

    _remove(key, entry, type = 'delete') {
        if (!this.store.has(key)) return false;
        this.store.delete(key);
        this.leases.delete(key);
        this.revision += 1;
        this._emit({
            type,
            key,
            value: null,
            rev: this.revision,
            index: entry.index,
            clock: this.clock,
        });
        return true;
    }

    _applySet({ key, value }, entry) {
        if (typeof key !== 'string' || key === '') {
            return { ok: false, error: 'set requires a key' };
        }
        const record = this._put(key, value, entry);
        return { ok: true, key, rev: record.rev };
    }

    _applyDelete({ key }, entry) {
        if (typeof key !== 'string' || key === '') {
            return { ok: false, error: 'delete requires a key' };
        }
        const removed = this._remove(key, entry);
        return { ok: true, key, deleted: removed, rev: this.revision };
    }

    /**
     * Compare-and-swap. `expectRev` of 0 means "the key must not exist", which
     * is how a caller claims a name exactly once. `expect` compares the value
     * instead, for callers that have not tracked revisions. Passing `value:
     * null` turns a successful CAS into a delete, which gives you a safe
     * conditional release.
     */
    _applyCas(command, entry) {
        const { key, expectRev, expect, value = null } = command;
        if (typeof key !== 'string' || key === '') {
            return { ok: false, error: 'cas requires a key' };
        }

        const current = this.store.get(key) || null;
        const currentRev = current ? current.rev : 0;

        if (expectRev !== undefined) {
            if (currentRev !== expectRev) {
                return {
                    ok: false,
                    error: 'revision mismatch',
                    key,
                    actualRev: currentRev,
                    actual: current ? current.value : null,
                };
            }
        } else if (expect !== undefined) {
            const actual = current ? current.value : null;
            if (JSON.stringify(actual) !== JSON.stringify(expect)) {
                return {
                    ok: false,
                    error: 'value mismatch',
                    key,
                    actualRev: currentRev,
                    actual,
                };
            }
        } else {
            return { ok: false, error: 'cas requires expectRev or expect' };
        }

        if (value === null) {
            this._remove(key, entry);
            return { ok: true, key, rev: this.revision, deleted: true };
        }
        const record = this._put(key, value, entry);
        return { ok: true, key, rev: record.rev };
    }

    _applyLeaseAcquire({ key, holder, ttlMs }, entry) {
        if (typeof key !== 'string' || key === '' || typeof holder !== 'string') {
            return { ok: false, error: 'lease-acquire requires key and holder' };
        }
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
            return { ok: false, error: 'lease-acquire requires a positive ttlMs' };
        }

        const existing = this.leases.get(key);
        if (existing && existing.holder !== holder) {
            // _expireLeases already ran, so anything still here is live.
            return {
                ok: false,
                error: 'held',
                key,
                holder: existing.holder,
                remainingMs: existing.expiresAt - this.clock,
            };
        }

        const expiresAt = this.clock + ttlMs;
        this.leases.set(key, { holder, ttlMs, expiresAt, rev: this.revision + 1 });
        const record = this._put(key, holder, entry, { lease: holder, type: 'lease-granted' });
        return { ok: true, key, holder, rev: record.rev, expiresAt, clock: this.clock };
    }

    _applyLeaseRenew({ key, holder, ttlMs }, entry) {
        const lease = this.leases.get(key);
        if (!lease) return { ok: false, error: 'expired', key };
        if (lease.holder !== holder) {
            return { ok: false, error: 'held', key, holder: lease.holder };
        }
        const extension = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : lease.ttlMs;
        lease.ttlMs = extension;
        lease.expiresAt = this.clock + extension;
        // A renewal deliberately does not bump the revision: watchers care that
        // ownership changed, not that the incumbent is still alive. Keeping it
        // silent is what stops heartbeat renewals from flooding every watcher.
        return {
            ok: true,
            key,
            holder,
            expiresAt: lease.expiresAt,
            clock: this.clock,
            renewed: true,
        };
    }

    _applyLeaseRelease({ key, holder }, entry) {
        const lease = this.leases.get(key);
        if (!lease) return { ok: true, key, released: false };
        if (lease.holder !== holder) {
            return { ok: false, error: 'held', key, holder: lease.holder };
        }
        this._remove(key, entry, 'lease-released');
        return { ok: true, key, released: true, rev: this.revision };
    }

    // ── vector index ─────────────────────────────────────────────────────────

    _applyIndexCreate({
        dim, M = 16, efConstruction = 200, seed = 0x9e3779b9,
        storage = 'float32', traversal = 'exact', rescoreFactor = 4,
    }) {
        if (!Number.isInteger(dim) || dim <= 0) {
            return { ok: false, error: 'index-create requires a positive integer dim' };
        }
        if (this.index) {
            // Idempotent for a replay of the same config, refused for a
            // different one. Recreating the index would silently drop every
            // vector committed before it, which is not something a single log
            // entry should be able to do by accident.
            const candidate = { dim, M, efConstruction, seed, storage, traversal, rescoreFactor };
            const same = Object.keys(candidate)
                .every((key) => this.indexConfig[key] === candidate[key]);
            return same
                ? { ok: true, alreadyExists: true, ...this.indexConfig }
                : { ok: false, error: 'an index already exists with a different configuration' };
        }

        // Quantization settings go through the log with everything else.
        // Storage precision changes the arithmetic every replica performs, so a
        // node configured locally to int8 while its peers ran float32 would
        // build a different graph and diverge — with nothing in any log to
        // explain why.
        this.indexConfig = { dim, M, efConstruction, seed, storage, traversal, rescoreFactor };
        this.index = new HnswIndex(this.indexConfig);
        this.revision += 1;
        return { ok: true, ...this.indexConfig };
    }

    /**
     * Inserts a vector that the *leader already computed*.
     *
     * The log carries the embedding, never the source text. Replicating text
     * and having each replica embed it would make state agreement depend on
     * bitwise-identical floating point across every node — and the deployment
     * target here is ARM while development is x86, with ONNX Runtime free to
     * choose different SIMD kernels on each. The vectors would differ in the
     * last few bits, the graphs would differ, and the divergence would show up
     * only as slightly different neighbours on some queries.
     *
     * Embedding once on the leader removes the question entirely: whatever the
     * leader computed is what every replica stores, bit for bit. It also means
     * the embedding model can be upgraded without the consensus layer caring,
     * and that a follower needs no model loaded at all to stay consistent.
     */
    _applyVectorUpsert({ id, vector, payload = null }, entry) {
        if (!this.index) return { ok: false, error: 'no index; commit index-create first' };
        if (typeof id !== 'string' || id === '') {
            return { ok: false, error: 'vector-upsert requires a string id' };
        }

        let decoded;
        try {
            decoded = decodeVector(vector);
        } catch (error) {
            return { ok: false, error: `undecodable vector: ${error.message}` };
        }
        if (decoded.length !== this.index.dim) {
            return {
                ok: false,
                error: `dimension mismatch: index is ${this.index.dim}, vector is ${decoded.length}`,
            };
        }

        const replaced = this.index.labelOf.has(id);
        this.index.upsert(id, decoded, payload);
        // The same entry feeds both indexes. Keeping them in one apply step is
        // what guarantees they can never disagree about which documents exist —
        // a separate "index the text" path would be a second source of truth.
        if (payload && typeof payload.text === 'string') this.sparse.add(id, payload.text);
        this.revision += 1;

        this._emit({
            type: replaced ? 'vector-replaced' : 'vector-added',
            key: `vector/${id}`,
            value: payload,
            rev: this.revision,
            index: entry.index,
            clock: this.clock,
        });

        return { ok: true, id, replaced, rev: this.revision, size: this.index.size };
    }

    _applyVectorDelete({ id }, entry) {
        if (!this.index) return { ok: false, error: 'no index; commit index-create first' };
        const removed = this.index.delete(id);
        this.sparse.remove(id);
        if (!removed) return { ok: true, id, deleted: false, rev: this.revision };

        this.revision += 1;
        this._emit({
            type: 'vector-deleted',
            key: `vector/${id}`,
            value: null,
            rev: this.revision,
            index: entry.index,
            clock: this.clock,
        });
        return { ok: true, id, deleted: true, rev: this.revision, size: this.index.size };
    }

    /**
     * Hybrid retrieval: dense and lexical, fused by rank.
     *
     * A read path, not an apply path — it mutates nothing and therefore does
     * not go through the log. Any replica can answer it from its local state,
     * and because that state is identical everywhere, every replica returns the
     * same ranking.
     *
     * Each retriever is asked for more than `k` before fusion: a document
     * ranked 15th by one and 2nd by the other should surface, and it cannot if
     * the first list was truncated at 10.
     */
    hybridSearch(queryVector, queryText, {
        k = 10, ef, filter = null, weights = null, denseOnly = false, sparseOnly = false,
    } = {}) {
        if (!this.index) throw new Error('no index has been created');
        const depth = Math.max(k * 4, 40);
        const rankings = [];

        if (!sparseOnly) {
            rankings.push(this.index.search(queryVector, depth, ef, { filter }));
        }
        if (!denseOnly && queryText) {
            const payloadOf = (id) => {
                const label = this.index.labelOf.get(id);
                return label === undefined ? null : this.index.payloads[label];
            };
            const lexical = this.sparse.search(queryText, depth, filter, payloadOf);
            for (const hit of lexical) hit.payload = payloadOf(hit.id);
            rankings.push(lexical);
        }

        if (rankings.length === 1) return rankings[0].slice(0, k);
        return reciprocalRankFusion(rankings, { weights, limit: k });
    }

    /** Debug/observability view. Not used by the apply path. */
    snapshot() {
        return {
            clock: this.clock,
            revision: this.revision,
            lastAppliedIndex: this.lastAppliedIndex,
            keys: this.list(),
            leases: [...this.leases.keys()].map((key) => this.leaseInfo(key)),
            // The fingerprint is the cheap cross-replica consistency check:
            // three nodes reporting the same hash have identical graphs, which
            // is a far stronger statement than agreeing on a few queries.
            index: this.index ? this.index.stats() : null,
            sparse: this.sparse.stats(),
            agent: this.agent.snapshot(),
        };
    }
}

module.exports = { StateMachine, encodeVector, decodeVector };
