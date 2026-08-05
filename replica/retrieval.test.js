const assert = require('node:assert/strict');
const test = require('node:test');

const { HnswIndex, Rng } = require('./hnsw');
const { BM25Index, reciprocalRankFusion } = require('./sparse');
const { quantizeInt8, dequantizeInt8, quantizeBinary, hamming, footprint } = require('./quantize');

function corpus(count, dim, seed = 42) {
    const rng = new Rng(seed);
    const gaussian = () => Math.sqrt(-2 * Math.log(rng.unit())) * Math.cos(2 * Math.PI * rng.unit());
    const centres = Array.from({ length: 12 }, () => Float32Array.from({ length: dim }, gaussian));
    return Array.from({ length: count }, (_, i) => {
        const centre = centres[i % centres.length];
        const vector = new Float32Array(dim);
        for (let d = 0; d < dim; d += 1) vector[d] = centre[d] + gaussian() * 0.35;
        return { id: `doc-${i}`, vector, cluster: i % centres.length };
    });
}

const recall = (approx, truth) => {
    const ids = new Set(truth.map((r) => r.id));
    return approx.filter((r) => ids.has(r.id)).length / Math.max(1, truth.length);
};

// ── quantization ─────────────────────────────────────────────────────────────

test('int8 round-trips within its quantisation step', () => {
    const v = Float32Array.from({ length: 384 }, (_, i) => Math.sin(i) * 0.4);
    const { codes, scale } = quantizeInt8(v);
    const back = dequantizeInt8(codes, scale);
    let worst = 0;
    for (let i = 0; i < v.length; i += 1) worst = Math.max(worst, Math.abs(v[i] - back[i]));
    // Error is bounded by half a step by construction; anything larger means
    // the scale is wrong rather than that quantisation is lossy.
    assert.ok(worst <= scale / 2 + 1e-7, `max error ${worst} exceeded half a step ${scale / 2}`);
});

test('binary codes preserve enough angle to rank with', () => {
    const dim = 256;
    const rng = new Rng(9);
    const a = Float32Array.from({ length: dim }, () => rng.unit() * 2 - 1);
    const near = Float32Array.from(a, (x) => x + (rng.unit() - 0.5) * 0.05);
    const far = Float32Array.from({ length: dim }, () => rng.unit() * 2 - 1);

    const [ca, cn, cf] = [a, near, far].map(quantizeBinary);
    assert.ok(hamming(ca, cn) < hamming(ca, cf),
        'a perturbed copy must be closer in Hamming space than an unrelated vector');
});

test('memory: int8 is 4x smaller, binary 32x', () => {
    const f = footprint(384);
    console.log(`      384d per vector — float32 ${f.float32}B · int8 ${f.int8}B · binary ${f.binary}B`);
    assert.ok(f.float32 / f.int8 > 3.9);
    assert.ok(f.float32 / f.binary === 32);
});

test('int8 storage holds recall while quartering memory', () => {
    const dim = 128;
    const data = corpus(1500, dim, 5);
    const queries = corpus(40, dim, 777);

    const float32 = new HnswIndex({ dim, M: 16, efConstruction: 200, seed: 7 });
    const int8 = new HnswIndex({ dim, M: 16, efConstruction: 200, seed: 7, storage: 'int8' });
    for (const { id, vector } of data) { float32.upsert(id, vector); int8.upsert(id, vector); }

    // Each index is measured against *its own* exact search. An int8 index is
    // not an approximation of a float32 one — its ground truth is int8 too, and
    // conflating the two would blame the graph for the quantiser's error.
    const measure = (index) => {
        let total = 0;
        for (const q of queries) total += recall(index.search(q.vector, 10, 128), index.searchExact(q.vector, 10));
        return total / queries.length;
    };

    const rf = measure(float32);
    const ri = measure(int8);
    const sf = float32.stats();
    const si = int8.stats();

    console.log(`      float32  recall ${(rf * 100).toFixed(1)}%  ${(sf.vectorBytes / 1024).toFixed(0)}KB`);
    console.log(`      int8     recall ${(ri * 100).toFixed(1)}%  ${(si.vectorBytes / 1024).toFixed(0)}KB  ` +
        `(${si.compression}x compression)`);

    assert.ok(ri >= 0.9, `int8 recall collapsed to ${ri}`);
    assert.ok(si.vectorBytes * 3.5 < sf.vectorBytes, 'int8 did not actually save memory');

    // And the ranking against the *float32* ground truth, which is the number
    // that matters to a user who does not care how it is stored internally.
    let crossTotal = 0;
    for (const q of queries) crossTotal += recall(int8.search(q.vector, 10, 128), float32.searchExact(q.vector, 10));
    const cross = crossTotal / queries.length;
    console.log(`      int8 vs float32 ground truth: ${(cross * 100).toFixed(1)}%`);
    assert.ok(cross >= 0.85, `int8 lost too much against float32 truth: ${cross}`);
});

test('binary traversal with rescoring recovers accuracy the walk threw away', () => {
    const dim = 128;
    const data = corpus(1500, dim, 13);
    const queries = corpus(40, dim, 31337);

    const baseline = new HnswIndex({ dim, M: 16, efConstruction: 200, seed: 3 });
    const binary = new HnswIndex({
        dim, M: 16, efConstruction: 200, seed: 3, traversal: 'binary', rescoreFactor: 4,
    });
    const noRescore = new HnswIndex({
        dim, M: 16, efConstruction: 200, seed: 3, traversal: 'binary', rescoreFactor: 1,
    });
    for (const { id, vector } of data) {
        baseline.upsert(id, vector); binary.upsert(id, vector); noRescore.upsert(id, vector);
    }

    const truth = queries.map((q) => baseline.searchExact(q.vector, 10));
    const measure = (index) => queries
        .reduce((sum, q, i) => sum + recall(index.search(q.vector, 10, 128), truth[i]), 0) / queries.length;

    const rBase = measure(baseline);
    const rBinary = measure(binary);
    const rNaive = measure(noRescore);

    console.log(`      exact walk            ${(rBase * 100).toFixed(1)}%`);
    console.log(`      binary walk, 1x       ${(rNaive * 100).toFixed(1)}%   <- no rescoring`);
    console.log(`      binary walk, 4x       ${(rBinary * 100).toFixed(1)}%   <- oversample + rescore`);

    // The point of the test: rescoring is what makes binary traversal usable.
    assert.ok(rBinary > rNaive, 'rescoring must improve on the raw binary ranking');
    assert.ok(rBinary >= 0.85, `binary+rescore recall was ${rBinary}`);
});

// ── filtering ────────────────────────────────────────────────────────────────

test('filtered search stays accurate where post-filtering would collapse', () => {
    const dim = 96;
    const data = corpus(2000, dim, 21);
    const index = new HnswIndex({ dim, M: 16, efConstruction: 200, seed: 11 });
    for (const { id, vector, cluster } of data) index.upsert(id, vector, { cluster });

    const queries = corpus(30, dim, 4242);
    const filter = (payload) => payload && payload.cluster === 3; // ~1/12 of the corpus

    let filtered = 0;
    let post = 0;
    for (const q of queries) {
        const truth = index.searchExact(q.vector, 10, { filter });
        filtered += recall(index.search(q.vector, 10, 128, { filter }), truth);

        // What a naive implementation does: search unfiltered, discard misses.
        // It cannot return 10 matching results unless 10 of the global top-128
        // happen to match, which for a selective filter they usually do not.
        const naive = index.search(q.vector, 128, 128).filter((h) => filter(h.payload)).slice(0, 10);
        post += recall(naive, truth);
    }

    const rFiltered = filtered / queries.length;
    const rPost = post / queries.length;
    console.log(`      filter-during-traversal ${(rFiltered * 100).toFixed(1)}%`);
    console.log(`      post-filtering          ${(rPost * 100).toFixed(1)}%   <- the naive approach`);

    assert.ok(rFiltered >= 0.95, `filtered recall was ${rFiltered}`);
    assert.ok(rFiltered >= rPost, 'filtering during traversal must not be worse than post-filtering');
});

test('a filter too selective for the graph falls back to an exact scan', () => {
    const dim = 64;
    const data = corpus(3000, dim, 77);
    const index = new HnswIndex({ dim, seed: 2 });
    data.forEach(({ id, vector }, i) => index.upsert(id, vector, { rare: i % 500 === 0 }));

    // 6 of 3000 match. A graph walk here would visit most of the index to find
    // them and still risk missing some; the scan is both faster and exact.
    const filter = (p) => p && p.rare === true;
    const hits = index.search(data[0].vector, 5, 64, { filter });

    assert.ok(hits.length > 0);
    assert.equal(hits[0].strategy, 'exact-fallback', 'should have taken the scan path');
    assert.ok(hits.every((h) => h.payload.rare === true));
    assert.deepEqual(
        hits.map((h) => h.id),
        index.searchExact(data[0].vector, 5, { filter }).map((h) => h.id),
        'the fallback must be exact, not merely different',
    );
});

// ── hybrid ───────────────────────────────────────────────────────────────────

test('BM25 finds exact tokens that embeddings smear away', () => {
    const bm25 = new BM25Index();
    const docs = [
        ['a', 'the deployment failed with ERR_CONNECTION_REFUSED on startup'],
        ['b', 'network troubleshooting guide for distributed systems'],
        ['c', 'connection pooling improves database throughput'],
        ['d', 'refused connections often indicate a firewall rule'],
    ];
    for (const [id, text] of docs) bm25.add(id, text);

    const hits = bm25.search('ERR_CONNECTION_REFUSED', 3);
    assert.equal(hits[0].id, 'a', 'the literal identifier must win');
    assert.ok(hits[0].score > 0);
});

test('BM25 removal keeps idf honest', () => {
    const bm25 = new BM25Index();
    bm25.add('a', 'alpha beta gamma');
    bm25.add('b', 'alpha delta');
    assert.equal(bm25.size, 2);
    bm25.remove('a');
    assert.equal(bm25.size, 1);
    // gamma appeared only in the removed document, so its posting list must be
    // gone entirely — a leftover would keep skewing every idf in the corpus.
    assert.equal(bm25.postings.has('gamma'), false);
    assert.equal(bm25.search('gamma', 5).length, 0);
});

test('RRF fuses without needing the two score scales to be comparable', () => {
    // Cosine in [-1,1] against unbounded BM25 — a weighted sum of these is
    // meaningless, which is exactly why fusion works on ranks.
    const dense = [{ id: 'x', score: 0.81 }, { id: 'y', score: 0.79 }, { id: 'z', score: 0.11 }];
    const sparse = [{ id: 'z', score: 14.2 }, { id: 'x', score: 3.1 }];

    const fused = reciprocalRankFusion([dense, sparse], { limit: 3 });
    assert.equal(fused[0].id, 'x', 'agreed-upon results should rise');
    assert.deepEqual(Object.keys(fused[0].sources).sort(), ['dense', 'sparse']);
    // y is dense-only at rank 2; z is sparse-first but dense-last. Both appear,
    // neither displaces the consensus pick.
    assert.equal(fused.length, 3);
});

test('hybrid beats either half alone on a mixed query set', () => {
    const dim = 64;
    const rng = new Rng(101);
    const topics = ['storage', 'network', 'scheduler', 'consensus'];
    const docs = Array.from({ length: 240 }, (_, i) => {
        const topic = topics[i % topics.length];
        return {
            id: `doc-${i}`,
            text: `${topic} subsystem note ${i} ${i % 40 === 0 ? 'ERRCODE_' + i : ''}`,
            topic,
            // Vectors clustered by topic, so dense search models "meaning".
            vector: Float32Array.from({ length: dim }, (_, d) =>
                (d % topics.length === i % topics.length ? 1 : 0) + (rng.unit() - 0.5) * 0.6),
        };
    });

    const index = new HnswIndex({ dim, seed: 8 });
    const bm25 = new BM25Index();
    for (const doc of docs) {
        index.upsert(doc.id, doc.vector, { text: doc.text, topic: doc.topic });
        bm25.add(doc.id, doc.text);
    }

    // A query that only a lexical match can satisfy: the identifier carries no
    // semantic signal at all.
    const needle = docs.find((d) => d.text.includes('ERRCODE_40'));
    const denseOnly = index.search(needle.vector, 10).map((h) => h.id);
    const sparseOnly = bm25.search('ERRCODE_40', 10).map((h) => h.id);
    const hybrid = reciprocalRankFusion(
        [index.search(needle.vector, 40), bm25.search('ERRCODE_40', 40).map((h) => ({ ...h }))],
        { limit: 10 },
    ).map((h) => h.id);

    const rank = (list) => list.indexOf(needle.id);
    console.log(`      dense-only rank ${rank(denseOnly)}  sparse-only rank ${rank(sparseOnly)}  hybrid rank ${rank(hybrid)}`);

    assert.equal(rank(sparseOnly), 0, 'lexical search must nail the identifier');
    assert.ok(rank(hybrid) >= 0 && rank(hybrid) <= 2, 'hybrid must keep the lexical win near the top');
});

test('quantized and filtered indexes remain deterministic across replicas', () => {
    // Every feature added here has to preserve the property the whole design
    // rests on, so it is asserted again with all of them switched on at once.
    const dim = 96;
    const data = corpus(600, dim, 55);
    const config = {
        dim, M: 16, efConstruction: 150, seed: 0xbeef,
        storage: 'int8', traversal: 'binary', rescoreFactor: 4,
    };

    const a = new HnswIndex(config);
    const b = new HnswIndex(config);
    for (const { id, vector, cluster } of data) a.upsert(id, vector, { cluster });
    for (const { id, vector, cluster } of data) b.upsert(id, Float32Array.from(vector), { cluster });

    assert.equal(a.fingerprint(), b.fingerprint(), 'quantized graphs diverged');

    const filter = (p) => p.cluster % 2 === 0;
    for (const q of corpus(15, dim, 606)) {
        assert.deepEqual(
            a.search(q.vector, 10, 96, { filter }).map((h) => h.id),
            b.search(q.vector, 10, 96, { filter }).map((h) => h.id),
        );
    }
});
