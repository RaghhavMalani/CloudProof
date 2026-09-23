/**
 * hnsw.js — Hierarchical Navigable Small World index, written to be a
 * deterministic Raft state machine.
 *
 * ── Why this is hand-written rather than hnswlib-node ────────────────────────
 * Not for the sake of it. HNSW is a *randomised* algorithm: each element is
 * assigned a level by an exponential draw, and that draw shapes the graph. A
 * Raft state machine must be deterministic — every replica applying the same
 * committed log must reach the same state — so the randomness has to be under
 * our control, seeded from something the log agrees on.
 *
 * A native library cannot give that guarantee across the deployment target.
 * Its RNG is C++ `std::mt19937` seeded per-process, its float arithmetic may
 * use FMA or SIMD paths that differ between x86 and ARM, and the plan here is
 * to run on Ampere ARM instances while developing on x86. Two replicas would
 * agree on which vectors exist and still disagree about which ten are nearest,
 * which is the worst kind of divergence: silent, plausible, and invisible until
 * someone compares results across nodes.
 *
 * In JavaScript, doubles are IEEE-754 with defined semantics and no
 * autovectorisation, so the same operations in the same order produce the same
 * bits everywhere. That makes determinism provable rather than hoped for, and
 * there is a test that asserts it.
 *
 * Two further details that determinism actually requires, both easy to miss:
 *
 *   1. Ties must break totally. Two candidates at identical distance must
 *      order the same way on every replica, so comparisons fall back to the
 *      external vector id (and only then the internal label). Without this the
 *      heap order depends on insertion
 *      history inside the priority queue and replicas diverge.
 *
 *   2. Level randomness belongs to an entry, not a process. Each vector id is
 *      hashed to a 32-bit seed and gets a fresh PRNG, so retries, snapshot
 *      restores, and read traffic cannot shift a shared random stream.
 *
 * Distance is cosine, implemented as negative inner product over vectors that
 * are normalised on the way in. Smaller is nearer throughout.
 */

const {
    quantizeInt8, dequantizeInt8, dotInt8,
    quantizeBinary, hamming, hammingToCosine, footprint,
} = require('./quantize');
const crypto = require('node:crypto');


// Browser builds do not expose Buffer; keep snapshots canonical with a runtime UTF-8 adapter.
const HAS_BUFFER = typeof Buffer !== 'undefined';

function encodeUtf8(text) {
    if (HAS_BUFFER) return Buffer.from(text, 'utf8');
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
    throw new Error('this runtime cannot encode UTF-8 snapshots');
}

function decodeUtf8(value) {
    if (typeof value === 'string') return value;
    if (HAS_BUFFER) return Buffer.from(value).toString('utf8');
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(value);
    throw new Error('this runtime cannot decode UTF-8 snapshots');
}
// ── deterministic PRNG ───────────────────────────────────────────────────────
// xorshift128, chosen because it is exactly reproducible in integer arithmetic
// and does not depend on Math.random's implementation-defined behaviour.
class Rng {
    constructor(seed = 0x9e3779b9) {
        this.x = seed >>> 0 || 1;
        this.y = 362436069;
        this.z = 521288629;
        this.w = 88675123;
    }

    next() {
        const t = (this.x ^ (this.x << 11)) >>> 0;
        this.x = this.y; this.y = this.z; this.z = this.w;
        this.w = ((this.w ^ (this.w >>> 19)) ^ (t ^ (t >>> 8))) >>> 0;
        return this.w;
    }

    /** Uniform in (0, 1]. Never returns 0, so log() below is always finite. */
    unit() {
        return (this.next() + 1) / 4294967297;
    }

    state() { return [this.x, this.y, this.z, this.w]; }
    restore([x, y, z, w]) { this.x = x; this.y = y; this.z = z; this.w = w; }
}

/** FNV-1a over UTF-16 code units. The exact hash is part of the file format. */
function hashId32(id) {
    let hash = 2166136261;
    for (let i = 0; i < id.length; i += 1) {
        hash ^= id.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

/**
 * Min-heap over {distance, label}, ordered by distance then label.
 *
 * The id tiebreak is not cosmetic. Vectors at equal distance are common
 * with normalised embeddings and duplicated documents, and without a total
 * order the heap's internal sift decides the winner — which depends on
 * insertion sequence inside the heap, not on the log.
 */
class Heap {
    constructor(invert = false, compare = compareCandidates) {
        this.items = [];
        this.invert = invert;
        this.compare = compare;
    }

    get size() { return this.items.length; }
    peek() { return this.items[0]; }

    _before(a, b) {
        const order = this.compare(a, b);
        return this.invert ? order > 0 : order < 0;
    }

    push(item) {
        const items = this.items;
        items.push(item);
        let i = items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (!this._before(items[i], items[parent])) break;
            [items[i], items[parent]] = [items[parent], items[i]];
            i = parent;
        }
    }

    pop() {
        const items = this.items;
        const top = items[0];
        const last = items.pop();
        if (items.length > 0) {
            items[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let best = i;
                if (l < items.length && this._before(items[l], items[best])) best = l;
                if (r < items.length && this._before(items[r], items[best])) best = r;
                if (best === i) break;
                [items[i], items[best]] = [items[best], items[i]];
                i = best;
            }
        }
        return top;
    }
}

class HnswIndex {
    /**
     * @param {object} options
     * @param {number} options.dim          vector dimensionality
     * @param {number} options.M            edges per node on layers above 0
     * @param {number} options.efConstruction breadth while building
     * @param {number} options.mL           fixed level multiplier
     */
    constructor({
        dim,
        M = 16,
        efConstruction = 200,
        mL = null,
        // How vectors are held in memory and scored precisely. int8 is a
        // quarter the size at a recall cost small enough to be within noise on
        // most corpora — see the benchmark in hnsw.test.js.
        storage = 'float32',
        // Whether the graph walk runs on 32x-smaller binary codes. The walk is
        // the memory-bandwidth-bound part, so this is where the speedup lives;
        // accuracy is recovered by rescoring at `storage` precision afterwards.
        traversal = 'exact',
        // How many candidates to rescore, as a multiple of k. Too low and
        // binary's imprecision leaks into the final ranking; too high and the
        // rescore starts to cost what the binary walk saved. 4 is the usual
        // sweet spot and the benchmark shows why.
        rescoreFactor = 4,
    } = {}) {
        if (!Number.isInteger(dim) || dim <= 0) throw new Error('dim must be a positive integer');
        if (!Number.isInteger(M) || M < 2) throw new Error('M must be an integer >= 2');
        if (!Number.isInteger(efConstruction) || efConstruction < M) {
            throw new Error('efConstruction must be an integer >= M');
        }
        const levelMultiplier = mL == null ? 1 / Math.log(M) : mL;
        if (!Number.isFinite(levelMultiplier) || levelMultiplier <= 0) {
            throw new Error('mL must be a positive finite number');
        }
        if (!['float32', 'int8'].includes(storage)) throw new Error(`unknown storage: ${storage}`);
        if (!['exact', 'binary'].includes(traversal)) throw new Error(`unknown traversal: ${traversal}`);

        this.dim = dim;
        this.storage = storage;
        this.traversal = traversal;
        this.rescoreFactor = rescoreFactor;
        this.M = M;
        // Layer 0 gets twice the connectivity. The bottom layer carries every
        // element and does the real work; starving it of edges is the usual
        // cause of poor recall.
        this.M0 = M * 2;
        this.efConstruction = efConstruction;
        this.mL = this.levelMultiplier = levelMultiplier;

        /**
         * @type {Float32Array[]} full-precision vectors. Populated only when
         * storage is float32; under int8 this stays empty and the codes below
         * are authoritative, which is where the 4x saving actually comes from.
         */
        this.vectors = [];
        /** @type {Int8Array[]} int8 codes, when storage is int8 */
        this.q8 = [];
        /** @type {number[]} per-vector dequantisation scale */
        this.scales = [];
        /** @type {Uint8Array[]} binary sign codes, when traversal is binary */
        this.bin = [];
        /** @type {(string|null)[]} external id per label; null once deleted */
        this.ids = [];
        /** @type {(object|null)[]} payload per label */
        this.payloads = [];
        /** @type {Uint8Array-like} soft-delete flags */
        this.deleted = [];
        /** @type {number[][][]} adjacency: links[label][level] = labels */
        this.links = [];
        /** @type {number[]} top level per label */
        this.levels = [];

        this.entryPoint = -1;
        this.maxLevel = -1;
        this.size = 0;          // live elements
        this.tombstones = 0;

        /** external id -> internal label */
        this.labelOf = new Map();
    }

    // ── distance ─────────────────────────────────────────────────────────────

    /**
     * Builds everything needed to compare a query against stored vectors: the
     * normalised float, its int8 codes, and its binary code. Computed once per
     * query rather than per comparison — doing this inside the distance
     * function is the single easiest way to make a quantized index slower than
     * the float one it replaced.
     */
    _prepare(rawVector) {
        const vector = HnswIndex.normalise(rawVector);
        const ctx = { vector, codes: null, scale: 1, bin: null };
        if (this.storage === 'int8') {
            const q = quantizeInt8(vector);
            ctx.codes = q.codes;
            ctx.scale = q.scale;
        }
        if (this.traversal === 'binary') ctx.bin = quantizeBinary(vector);
        return ctx;
    }

    /** Negative inner product: smaller is nearer, over unit vectors. */
    _dotDistance(a, b) {
        let sum = 0;
        for (let i = 0; i < this.dim; i += 1) sum += a[i] * b[i];
        return -sum;
    }

    /**
     * Precise distance at whatever precision this index stores.
     *
     * This is what the graph is built with and what rescoring uses, so it is
     * the definition of "correct ordering" for this index — an int8 index is
     * not approximating a float32 one, it *is* an int8 index, and its exact
     * search is int8 too. Measuring recall against a float32 baseline would be
     * conflating two separate questions.
     */
    _distStored(ctx, label) {
        if (this.storage === 'int8') {
            return -dotInt8(ctx.codes, ctx.scale, this.q8[label], this.scales[label]);
        }
        return this._dotDistance(ctx.vector, this.vectors[label]);
    }

    /**
     * Distance used while walking the graph. Under binary traversal this reads
     * 48 bytes per candidate instead of 1536 and compares them with popcount,
     * which is where the speedup comes from — the walk is bound by cache
     * misses, not arithmetic.
     */
    _distWalk(ctx, label) {
        if (this.traversal === 'binary') {
            return -hammingToCosine(hamming(ctx.bin, this.bin[label]), this.dim);
        }
        return this._distStored(ctx, label);
    }

    _storedVector(label) {
        return this.storage === 'int8'
            ? dequantizeInt8(this.q8[label], this.scales[label])
            : this.vectors[label];
    }

    static normalise(vector) {
        const out = Float32Array.from(vector);
        let norm = 0;
        for (let i = 0; i < out.length; i += 1) norm += out[i] * out[i];
        norm = Math.sqrt(norm);
        // A zero vector has no direction; leaving it alone is better than
        // dividing by zero and producing NaNs that poison every comparison.
        if (norm === 0) return out;
        const scaled = new Float32Array(out.length);
        for (let i = 0; i < out.length; i += 1) scaled[i] = out[i] / norm;
        return scaled;
    }

    // ── construction ─────────────────────────────────────────────────────────

    _randomLevel(id) {
        const rng = new Rng(hashId32(id));
        return Math.floor(-Math.log(rng.unit()) * this.levelMultiplier);
    }

    _candidate(label, distance) {
        return { label, id: this.ids[label], distance };
    }

    _isBetter(distance, label, otherDistance, otherLabel) {
        return compareCandidates(
            this._candidate(label, distance),
            this._candidate(otherLabel, otherDistance),
        ) < 0;
    }

    _sortLabels(labels) {
        return labels.slice().sort((a, b) => compareIds(this.ids[a], this.ids[b]) || a - b);
    }

    _orderedNeighbours(label, level) {
        return this._sortLabels(this.links[label][level] || []);
    }

    /**
     * Inserts or replaces a vector.
     *
     * Replacement is a tombstone plus a fresh insert rather than an in-place
     * edit. Rewiring an existing node's neighbourhood correctly is far more
     * intricate than it looks — the node's inbound edges live in other nodes'
     * link lists — and getting it subtly wrong degrades recall in a way that no
     * test would catch. Tombstones cost memory and are reclaimed by rebuilding.
     */
    upsert(id, rawVector, payload = null) {
        if (typeof id !== 'string' || id.length === 0) {
            throw new Error('id must be a non-empty string');
        }
        if (!rawVector || typeof rawVector.length !== 'number') {
            throw new Error('vector must be an array-like value');
        }
        if (rawVector.length !== this.dim) {
            throw new Error(`expected ${this.dim} dimensions, received ${rawVector.length}`);
        }

        for (let i = 0; i < rawVector.length; i += 1) {
            if (!Number.isFinite(rawVector[i])) throw new Error('vector values must be finite numbers');
        }
        payload = canonicalClone(payload);
        const existing = this.labelOf.get(id);
        if (existing !== undefined) this._tombstone(existing);

        const ctx = this._prepare(rawVector);
        const vector = ctx.vector;
        const label = this.ids.length;
        const level = this._randomLevel(id);

        // Under int8 storage the float32 copy is deliberately dropped after
        // quantising — keeping it would preserve accuracy and defeat the entire
        // point, since the memory saving *is* the feature.
        if (this.storage === 'int8') {
            this.q8.push(ctx.codes);
            this.scales.push(ctx.scale);
        } else {
            this.vectors.push(vector);
        }
        if (this.traversal === 'binary') this.bin.push(ctx.bin);

        this.ids.push(id);
        this.payloads.push(payload);
        this.deleted.push(0);
        this.levels.push(level);
        this.links.push(Array.from({ length: level + 1 }, () => []));
        this.labelOf.set(id, label);
        this.size += 1;

        if (this.entryPoint === -1) {
            this.entryPoint = label;
            this.maxLevel = level;
            return label;
        }

        let current = this.entryPoint;
        let currentDistance = this._distStored(ctx, current);

        // Descend greedily through layers above the new element's own level.
        // Construction always uses stored precision, never the binary walk: a
        // graph built on 1-bit distances is measurably worse, and building is a
        // one-time cost where being cheap is a false economy.
        for (let l = this.maxLevel; l > level; l -= 1) {
            let improved = true;
            while (improved) {
                improved = false;
                for (const neighbour of this._orderedNeighbours(current, l)) {
                    const d = this._distStored(ctx, neighbour);
                    // Strict improvement, with the id tiebreak, so a plateau
                    // of equidistant nodes cannot cycle.
                    if (this._isBetter(d, neighbour, currentDistance, current)) {
                        current = neighbour;
                        currentDistance = d;
                        improved = true;
                    }
                }
            }
        }

        // Connect at every layer the element belongs to.
        for (let l = Math.min(level, this.maxLevel); l >= 0; l -= 1) {
            const candidates = this._searchLayer(ctx, current, this.efConstruction, l, {
                includeDeleted: true,
                precise: true,
            });
            const chosen = this._selectNeighbours(candidates, l === 0 ? this.M0 : this.M);

            this.links[label][l] = this._sortLabels(chosen);

            for (const neighbour of chosen) {
                const neighbourLinks = this.links[neighbour][l];
                neighbourLinks.push(label);
                const limit = l === 0 ? this.M0 : this.M;
                if (neighbourLinks.length > limit) {
                    // Over-connected: re-select from the neighbour's own point
                    // of view rather than dropping the newest edge, which would
                    // bias the graph toward early inserts.
                    const repacked = this._selectNeighbours(
                        neighbourLinks.map((n) => ({
                            label: n,
                            id: this.ids[n],
                            distance: this._distLabels(neighbour, n),
                        })),
                        limit,
                    );
                    this.links[neighbour][l] = this._sortLabels(repacked);
                } else {
                    this.links[neighbour][l] = this._sortLabels(neighbourLinks);
                }
            }

            if (chosen.length > 0) current = chosen[0];
        }

        if (level > this.maxLevel || (
            level === this.maxLevel
            && compareIds(id, this.ids[this.entryPoint]) < 0
        )) {
            this.maxLevel = level;
            this.entryPoint = label;
        }

        return label;
    }

    /**
     * Best-first search within one layer.
     *
     * `includeDeleted` is true during construction: tombstoned nodes still hold
     * the graph together, and skipping them while building would tear holes in
     * connectivity. Queries exclude them.
     */
    _searchLayer(ctx, entry, ef, level, { includeDeleted = false, precise = false, filter = null } = {}) {
        const distance = precise
            ? (label) => this._distStored(ctx, label)
            : (label) => this._distWalk(ctx, label);

        // Whether a node may be *returned*. Note that this never gates whether
        // a node is *traversed through* — see the loop below.
        const admits = (label) => {
            if (!includeDeleted && this.deleted[label]) return false;
            if (filter && !filter(this.payloads[label], this.ids[label])) return false;
            return true;
        };

        const visited = new Set([entry]);
        const entryDistance = distance(entry);

        const candidates = new Heap();          // nearest first
        const results = new Heap(true);         // furthest first
        candidates.push(this._candidate(entry, entryDistance));
        if (admits(entry)) results.push(this._candidate(entry, entryDistance));

        while (candidates.size > 0) {
            const nearest = candidates.pop();
            const furthest = results.peek();
            // Everything remaining is further than what we already have — but
            // only stop early once the result set is actually full, otherwise a
            // selective filter terminates the walk before it has found
            // anything.
            if (results.size >= ef && furthest && compareCandidates(nearest, furthest) > 0) {
                break;
            }

            for (const neighbour of this._orderedNeighbours(nearest.label, level)) {
                if (visited.has(neighbour)) continue;
                visited.add(neighbour);

                const d = distance(neighbour);
                const worst = results.peek();
                const candidate = this._candidate(neighbour, d);
                const admissible = results.size < ef || !worst
                    || compareCandidates(candidate, worst) < 0;

                if (!admissible) continue;

                // Pushed as a traversal candidate regardless of whether it
                // passes the filter. This is the whole difference between
                // filtering correctly and filtering naively: nodes that fail
                // the predicate are still the edges holding the graph
                // together, and refusing to walk through them tears the layer
                // into disconnected islands. Post-filtering — searching first,
                // then discarding — has the opposite failure: it returns k
                // results of which only a handful match, so recall collapses
                // exactly when the filter is most useful.
                candidates.push(candidate);

                if (admits(neighbour)) {
                    results.push(candidate);
                    if (results.size > ef) results.pop();
                }
            }
        }

        return results.items.slice().sort(compareCandidates);
    }

    /** Distance between two stored vectors, without materialising either. */
    _distLabels(a, b) {
        if (this.storage === 'int8') {
            return -dotInt8(this.q8[a], this.scales[a], this.q8[b], this.scales[b]);
        }
        return this._dotDistance(this.vectors[a], this.vectors[b]);
    }

    /**
     * Neighbour selection heuristic — Algorithm 4 from the HNSW paper.
     *
     * Taking the M nearest candidates is the obvious approach and produces a
     * badly clustered graph: in a dense region every node links only to its
     * immediate neighbours and the layer stops being navigable. The heuristic
     * keeps a candidate only if it is closer to the query than to any neighbour
     * already chosen, which preserves long-range edges across clusters and is
     * what makes the "small world" property hold.
     */
    _selectNeighbours(candidates, limit) {
        const sorted = candidates.slice().sort(compareCandidates);
        const chosen = [];

        for (const candidate of sorted) {
            if (chosen.length >= limit) break;
            let keep = true;
            for (const already of chosen) {
                if (this._distLabels(candidate.label, already) < candidate.distance) {
                    keep = false;
                    break;
                }
            }
            if (keep) chosen.push(candidate.label);
        }

        // The heuristic can be too aggressive on small or degenerate sets and
        // return almost nothing, which disconnects the graph. Backfill with the
        // nearest rejects rather than leaving a node stranded.
        if (chosen.length < limit) {
            for (const candidate of sorted) {
                if (chosen.length >= limit) break;
                if (!chosen.includes(candidate.label)) chosen.push(candidate.label);
            }
        }

        return chosen;
    }

    _tombstone(label) {
        if (this.deleted[label]) return false;
        this.deleted[label] = 1;
        this.size -= 1;
        this.tombstones += 1;
        return true;
    }

    delete(id) {
        const label = this.labelOf.get(id);
        if (label === undefined) return false;
        const removed = this._tombstone(label);
        this.labelOf.delete(id);
        return removed;
    }

    // ── query ────────────────────────────────────────────────────────────────

    /**
     * Approximate k nearest neighbours.
     *
     * `ef` trades recall against latency and is a query-time knob, so it is not
     * replicated and does not have to match across replicas — two nodes
     * answering the same query with different ef may legitimately return
     * different results. What must match is the graph, which is why id-derived
     * levels and the log's apply order are load-bearing.
     */
    search(rawQuery, k = 10, ef = Math.max(k, 64), { filter = null } = {}) {
        if (this.entryPoint === -1 || this.size === 0) return [];
        const ctx = this._prepare(rawQuery);

        // ── adaptive strategy for filtered queries ───────────────────────────
        // A graph search under a highly selective filter is pathological: the
        // walk visits thousands of nodes to find the handful that match, and
        // recall still suffers because the matching nodes may not be reachable
        // from each other. Below a threshold it is both faster *and* more
        // accurate to scan the matching subset exhaustively. Cardinality is
        // counted over payloads only — no vector arithmetic — so the check is
        // cheap relative to the search it might replace.
        if (filter) {
            let matching = 0;
            for (let label = 0; label < this.ids.length; label += 1) {
                if (!this.deleted[label] && filter(this.payloads[label], this.ids[label])) matching += 1;
            }
            const selectivity = matching / Math.max(1, this.size);
            if (matching === 0) return [];
            if (selectivity < 0.02 || matching <= Math.max(k * 8, 128)) {
                return this._exactScan(ctx, k, filter, 'exact-fallback');
            }
        }

        let current = this.entryPoint;
        let currentDistance = this._distWalk(ctx, current);

        for (let l = this.maxLevel; l > 0; l -= 1) {
            let improved = true;
            while (improved) {
                improved = false;
                for (const neighbour of this._orderedNeighbours(current, l)) {
                    const d = this._distWalk(ctx, neighbour);
                    if (this._isBetter(d, neighbour, currentDistance, current)) {
                        current = neighbour;
                        currentDistance = d;
                        improved = true;
                    }
                }
            }
        }

        // Two independent reasons to widen the beam.
        //
        // Filtering: a fraction of what the walk finds gets excluded, so ef has
        // to be larger to end up with k survivors.
        //
        // Binary traversal: `rescoreFactor` widens the *search*, not the
        // shortlist. This was the bug in the first version — oversampling the
        // slice after the walk cannot recover a candidate the walk never
        // visited, and on clustered data Hamming distance pushes true
        // neighbours well outside the top-k. Recall went from 26% to the number
        // in the benchmark by moving the multiplier here.
        let effectiveEf = Math.max(ef, k);
        if (this.traversal === 'binary') effectiveEf *= this.rescoreFactor;
        if (filter) effectiveEf *= 2;

        const found = this._searchLayer(ctx, current, effectiveEf, 0, { filter });

        if (this.traversal !== 'binary') {
            return found.slice(0, k).map((c) => this._hit(c.label, -c.distance));
        }

        // ── rescoring ────────────────────────────────────────────────────────
        // Every candidate the walk surfaced is re-ranked at stored precision.
        // Hamming knows the sign of each dimension and nothing about magnitude,
        // so it is fine for deciding *where to look* and useless for deciding
        // *what to return*. Rescoring costs one exact distance per candidate
        // already visited, which is negligible beside the walk that found them.
        const rescored = found
            .map((c) => this._candidate(c.label, this._distStored(ctx, c.label)))
            .sort(compareCandidates);
        return rescored.slice(0, k).map((c) => this._hit(c.label, -c.distance));
    }

    _hit(label, score) {
        return { id: this.ids[label], score, payload: this.payloads[label] };
    }

    _exactScan(ctx, k, filter, strategy) {
        const scored = [];
        for (let label = 0; label < this.ids.length; label += 1) {
            if (this.deleted[label]) continue;
            if (filter && !filter(this.payloads[label], this.ids[label])) continue;
            scored.push(this._candidate(label, this._distStored(ctx, label)));
        }
        scored.sort(compareCandidates);
        const hits = scored.slice(0, k).map((c) => this._hit(c.label, -c.distance));
        if (strategy) for (const hit of hits) hit.strategy = strategy;
        return hits;
    }

    /**
     * Exhaustive search at stored precision — the ground truth recall is
     * measured against.
     *
     * Note this scores at *this index's* precision, not float32. An int8 index
     * is not an approximation of a float32 one; it is an int8 index whose exact
     * answer is also int8. Comparing its graph search against a float32 scan
     * would fold two independent error sources into one number and make the
     * graph look worse than it is.
     */
    searchExact(rawQuery, k = 10, { filter = null } = {}) {
        return this._exactScan(this._prepare(rawQuery), k, filter, null);
    }

    _paramsHeader() {
        return {
            dim: this.dim,
            M: this.M,
            efConstruction: this.efConstruction,
            mL: this.mL,
            storage: this.storage,
            traversal: this.traversal,
            rescoreFactor: this.rescoreFactor,
        };
    }

    /**
     * Canonical, complete index image. Its bytes are the replica checksum
     * source, so vectors and metadata are covered as well as graph edges.
     */
    serialize() {
        const deleted = [];
        for (let label = 0; label < this.deleted.length; label += 1) {
            if (this.deleted[label]) deleted.push(label);
        }

        const state = {
            format: 'cloudproof-hnsw',
            version: 1,
            params: this._paramsHeader(),
            entryPoint: this.entryPoint,
            maxLevel: this.maxLevel,
            ids: this.ids.slice(),
            metadata: this.payloads,
            deleted,
            levels: this.levels.slice(),
            links: this.links.map((perLevel) =>
                perLevel.map((neighbours) => this._sortLabels(neighbours))),
            vectors: this.storage === 'float32'
                ? this.vectors.map((vector) => Array.from(vector))
                : null,
            q8: this.storage === 'int8'
                ? this.q8.map((vector) => Array.from(vector))
                : null,
            scales: this.storage === 'int8' ? this.scales.slice() : null,
            binary: this.traversal === 'binary'
                ? this.bin.map((vector) => Array.from(vector))
                : null,
        };

        return encodeUtf8(stableStringify(state));
    }

    checksum() {
        return crypto.createHash('sha256').update(this.serialize()).digest('hex');
    }

    /**
     * Loads a canonical image and optionally checks its parameter header
     * against cluster configuration. A mismatch is fatal: accepting it would
     * let one replica build a different graph from the same future log.
     */
    static deserialize(serialized, expectedParams = null) {
        let state;
        try {
            const text = decodeUtf8(serialized);
            state = JSON.parse(text);
        } catch (error) {
            throw new Error('invalid HNSW snapshot: ' + error.message);
        }

        snapshotAssert(state && state.format === 'cloudproof-hnsw', 'unknown format');
        snapshotAssert(state.version === 1, 'unsupported version');
        snapshotAssert(state.params && typeof state.params === 'object', 'missing params header');

        if (expectedParams) {
            const expected = { ...expectedParams };
            if (expected.mL == null && Number.isInteger(expected.M) && expected.M >= 2) {
                expected.mL = 1 / Math.log(expected.M);
            }
            for (const key of [
                'dim', 'M', 'efConstruction', 'mL',
                'storage', 'traversal', 'rescoreFactor',
            ]) {
                if (Object.prototype.hasOwnProperty.call(expected, key)) {
                    snapshotAssert(
                        Object.is(state.params[key], expected[key]),
                        'parameter mismatch for ' + key,
                    );
                }
            }
        }

        const index = new HnswIndex(state.params);
        const capacity = Array.isArray(state.ids) ? state.ids.length : -1;
        snapshotAssert(capacity >= 0, 'ids must be an array');
        snapshotAssert(Array.isArray(state.metadata) && state.metadata.length === capacity,
            'metadata length mismatch');
        snapshotAssert(Array.isArray(state.levels) && state.levels.length === capacity,
            'levels length mismatch');
        snapshotAssert(Array.isArray(state.links) && state.links.length === capacity,
            'links length mismatch');
        snapshotAssert(Array.isArray(state.deleted), 'deleted must be an array');

        index.ids = state.ids.slice();
        index.payloads = state.metadata.map((value) => canonicalClone(value));
        index.levels = state.levels.slice();
        index.deleted = Array(capacity).fill(0);
        const deletedSeen = new Set();
        for (const label of state.deleted) {
            snapshotAssert(Number.isInteger(label) && label >= 0 && label < capacity,
                'invalid deleted label');
            snapshotAssert(!deletedSeen.has(label), 'duplicate deleted label');
            deletedSeen.add(label);
            index.deleted[label] = 1;
        }

        for (let label = 0; label < capacity; label += 1) {
            snapshotAssert(typeof index.ids[label] === 'string' && index.ids[label].length > 0,
                'invalid id at label ' + label);
            snapshotAssert(Number.isInteger(index.levels[label]) && index.levels[label] >= 0,
                'invalid level at label ' + label);
            const perLevel = state.links[label];
            snapshotAssert(Array.isArray(perLevel)
                && perLevel.length === index.levels[label] + 1,
            'link level mismatch at label ' + label);
        }

        index.links = state.links.map((perLevel, label) =>
            perLevel.map((neighbours, level) => {
                snapshotAssert(Array.isArray(neighbours), 'neighbours must be arrays');
                const seen = new Set();
                for (const neighbour of neighbours) {
                    snapshotAssert(Number.isInteger(neighbour)
                        && neighbour >= 0 && neighbour < capacity,
                    'invalid neighbour label');
                    snapshotAssert(neighbour !== label, 'self edge');
                    snapshotAssert(index.levels[neighbour] >= level, 'edge targets missing level');
                    snapshotAssert(!seen.has(neighbour), 'duplicate edge');
                    seen.add(neighbour);
                }
                const sorted = index._sortLabels(neighbours);
                snapshotAssert(sorted.every((value, i) => value === neighbours[i]),
                    'neighbour list is not canonical');
                return neighbours.slice();
            }));

        if (index.storage === 'float32') {
            snapshotAssert(Array.isArray(state.vectors) && state.vectors.length === capacity,
                'vectors length mismatch');
            index.vectors = state.vectors.map((vector) =>
                restoreVector(vector, index.dim, Float32Array));
        } else {
            snapshotAssert(Array.isArray(state.q8) && state.q8.length === capacity,
                'q8 length mismatch');
            snapshotAssert(Array.isArray(state.scales) && state.scales.length === capacity,
                'scales length mismatch');
            index.q8 = state.q8.map((vector) =>
                restoreVector(vector, index.dim, Int8Array));
            index.scales = state.scales.slice();
            snapshotAssert(index.scales.every((scale) => Number.isFinite(scale) && scale > 0),
                'invalid quantization scale');
        }

        if (index.traversal === 'binary') {
            const bytes = Math.ceil(index.dim / 8);
            snapshotAssert(Array.isArray(state.binary) && state.binary.length === capacity,
                'binary length mismatch');
            index.bin = state.binary.map((vector) =>
                restoreVector(vector, bytes, Uint8Array));
        }

        let computedMax = -1;
        for (const level of index.levels) {
            if (level > computedMax) computedMax = level;
        }
        snapshotAssert(state.maxLevel === computedMax, 'maxLevel mismatch');
        snapshotAssert(
            capacity === 0
                ? state.entryPoint === -1
                : Number.isInteger(state.entryPoint)
                    && state.entryPoint >= 0
                    && state.entryPoint < capacity
                    && index.levels[state.entryPoint] === computedMax,
            'entryPoint mismatch',
        );
        index.entryPoint = state.entryPoint;
        index.maxLevel = state.maxLevel;
        index.tombstones = state.deleted.length;
        index.size = capacity - index.tombstones;
        index.labelOf = new Map();
        for (let label = 0; label < capacity; label += 1) {
            if (index.deleted[label]) continue;
            snapshotAssert(!index.labelOf.has(index.ids[label]), 'duplicate live id');
            index.labelOf.set(index.ids[label], label);
        }

        return index;
    }

    // ── introspection ────────────────────────────────────────────────────────

    /**
     * A structural fingerprint of the graph.
     *
     * This is what the determinism test compares. Comparing query results alone
     * would be weaker: two different graphs can agree on easy queries and
     * diverge only on the hard ones, so the assertion is made against the
     * structure itself.
     */
    fingerprint() {
        return this.checksum();
    }

    stats() {
        let edges = 0;
        for (const perLevel of this.links) for (const level of perLevel) edges += level.length;

        const perVector = footprint(this.dim);
        const vectorBytes = this.ids.length
            * (this.storage === 'int8' ? perVector.int8 : perVector.float32)
            + (this.traversal === 'binary' ? this.ids.length * perVector.binary : 0);

        return {
            dim: this.dim,
            size: this.size,
            tombstones: this.tombstones,
            capacity: this.ids.length,
            maxLevel: this.maxLevel,
            edges,
            M: this.M,
            efConstruction: this.efConstruction,
            mL: this.mL,
            storage: this.storage,
            traversal: this.traversal,
            rescoreFactor: this.rescoreFactor,
            vectorBytes,
            // What the same corpus would cost stored naively, so the saving is
            // visible without arithmetic.
            float32Bytes: this.ids.length * perVector.float32,
            compression: Number((this.ids.length * perVector.float32 / Math.max(1, vectorBytes)).toFixed(2)),
            fingerprint: this.fingerprint(),
        };
    }
}

function canonicalClone(value, stack = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('metadata numbers must be finite');
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object') {
        throw new Error('metadata must be JSON-compatible');
    }
    if (stack.has(value)) throw new Error('metadata must not contain cycles');

    stack.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item) => canonicalClone(item, stack));
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error('metadata must contain only arrays and plain objects');
        }
        const clone = {};
        for (const key of Object.keys(value).sort(compareIds)) {
            clone[key] = canonicalClone(value[key], stack);
        }
        return clone;
    } finally {
        stack.delete(value);
    }
}

function stableStringify(value) {
    return JSON.stringify(canonicalClone(value));
}

function snapshotAssert(condition, message) {
    if (!condition) throw new Error('invalid HNSW snapshot: ' + message);
}

function restoreVector(values, length, Type) {
    snapshotAssert(Array.isArray(values) && values.length === length, 'vector length mismatch');
    for (const value of values) {
        snapshotAssert(Number.isFinite(value), 'vector contains a non-finite number');
        if (Type === Int8Array) {
            snapshotAssert(Number.isInteger(value) && value >= -128 && value <= 127,
                'invalid int8 value');
        }
        if (Type === Uint8Array) {
            snapshotAssert(Number.isInteger(value) && value >= 0 && value <= 255,
                'invalid uint8 value');
        }
    }
    return Type.from(values);
}

function compareIds(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/** Total order: distance, external id, then internal label. */
function compareCandidates(a, b) {
    if (a.distance !== b.distance) return a.distance - b.distance;
    const byId = compareIds(a.id, b.id);
    if (byId !== 0) return byId;
    return a.label - b.label;
}

module.exports = { HnswIndex, Rng, Heap, hashId32 };
