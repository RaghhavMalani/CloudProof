const assert = require('node:assert/strict');
const test = require('node:test');

const { HnswIndex, Rng, hashId32 } = require('./hnsw');

/** Deterministic vector generator, so the corpus is identical every run. */
function corpus(count, dim, seed = 42) {
    const rng = new Rng(seed);
    const gaussian = () => {
        // Box-Muller. Clustered data is a much harder and more realistic test
        // than uniform noise, where every point is roughly equidistant and
        // recall looks artificially good.
        const u = rng.unit();
        const v = rng.unit();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    const centres = Array.from({ length: 8 }, () =>
        Float32Array.from({ length: dim }, () => gaussian()));

    return Array.from({ length: count }, (_, i) => {
        const centre = centres[i % centres.length];
        const vector = new Float32Array(dim);
        for (let d = 0; d < dim; d += 1) vector[d] = centre[d] + gaussian() * 0.35;
        return { id: `doc-${i}`, vector };
    });
}

const recallAt = (approx, exact) => {
    const truth = new Set(exact.map((r) => r.id));
    return approx.filter((r) => truth.has(r.id)).length / Math.max(1, exact.length);
};

test('finds the exact nearest neighbour of a stored vector', () => {
    const index = new HnswIndex({ dim: 32, M: 16, efConstruction: 100 });
    const data = corpus(300, 32);
    for (const { id, vector } of data) index.upsert(id, vector);

    for (const probe of [0, 77, 199, 299]) {
        const hits = index.search(data[probe].vector, 5);
        assert.equal(hits[0].id, data[probe].id, `querying a stored vector should return it first`);
        assert.ok(hits[0].score > 0.99, `self-similarity should be ~1, got ${hits[0].score}`);
    }
});

test('recall@10 against exact search is high on clustered data', () => {
    const dim = 64;
    const index = new HnswIndex({ dim, M: 16, efConstruction: 200 });
    const data = corpus(1000, dim, 7);
    for (const { id, vector } of data) index.upsert(id, vector);

    const queries = corpus(50, dim, 999);
    let total = 0;
    for (const query of queries) {
        total += recallAt(index.search(query.vector, 10, 128), index.searchExact(query.vector, 10));
    }
    const recall = total / queries.length;

    console.log(`      recall@10 = ${(recall * 100).toFixed(1)}% over ${queries.length} queries, 1000 vectors`);
    // An approximate index that matched exact search perfectly would mean the
    // graph is degenerating into a scan. Anything below 0.9 is a real defect.
    assert.ok(recall >= 0.9, `recall@10 was ${recall}, expected >= 0.9`);
});

test('raising ef improves recall — the graph is genuinely navigable', () => {
    const dim = 48;
    const index = new HnswIndex({ dim, M: 12, efConstruction: 120 });
    const data = corpus(800, dim, 3);
    for (const { id, vector } of data) index.upsert(id, vector);
    const queries = corpus(30, dim, 555);

    const measure = (ef) => {
        let total = 0;
        for (const q of queries) {
            total += recallAt(index.search(q.vector, 10, ef), index.searchExact(q.vector, 10));
        }
        return total / queries.length;
    };

    const low = measure(10);
    const high = measure(200);
    console.log(`      ef=10 → ${(low * 100).toFixed(1)}%   ef=200 → ${(high * 100).toFixed(1)}%`);
    // If ef made no difference the search would not be exploring the graph at
    // all, which is the signature of a broken layer descent.
    assert.ok(high >= low, 'higher ef must not reduce recall');
    assert.ok(high > 0.9, `recall at ef=200 was ${high}`);
});

test('three independently built indexes serialize to byte-identical graphs', () => {
    const dim = 40;
    const data = corpus(500, dim, 11);
    const config = {
        dim,
        M: 16,
        efConstruction: 150,
        mL: 1 / Math.log(16),
    };

    const replicas = Array.from({ length: 3 }, () => new HnswIndex(config));
    for (const { id, vector } of data) {
        replicas[0].upsert(id, vector, { source: 'test', ordinal: Number(id.slice(4)) });
        replicas[1].upsert(id, Float32Array.from(vector), { ordinal: Number(id.slice(4)), source: 'test' });
        replicas[2].upsert(id, Array.from(vector), { source: 'test', ordinal: Number(id.slice(4)) });
    }

    const expected = replicas[0].serialize();
    for (const replica of replicas.slice(1)) {
        assert.deepEqual(replica.serialize(), expected);
        assert.equal(replica.checksum(), replicas[0].checksum());
    }
});

test('each level is seeded solely from the vector id', () => {
    const dim = 32;
    const data = corpus(100, dim, 13);
    const config = { dim, M: 16, efConstruction: 100, mL: 1 / Math.log(16) };
    const forward = new HnswIndex(config);
    const reversed = new HnswIndex(config);
    for (const item of data) forward.upsert(item.id, item.vector);
    for (const item of [...data].reverse()) reversed.upsert(item.id, item.vector);

    for (const { id } of data) {
        const expected = Math.floor(
            -Math.log(new Rng(hashId32(id)).unit()) * config.mL,
        );
        assert.equal(forward.levels[forward.labelOf.get(id)], expected);
        assert.equal(reversed.levels[reversed.labelOf.get(id)], expected);
    }
});


test('different apply timing cannot change a shared committed log', async () => {
    const dim = 24;
    const data = corpus(120, dim, 29);
    const config = { dim, M: 12, efConstruction: 96, mL: 1 / Math.log(12) };
    const replicas = Array.from({ length: 3 }, () => new HnswIndex(config));

    await Promise.all(replicas.map(async (index, replica) => {
        for (let i = 0; i < data.length; i += 1) {
            if ((i + replica) % 7 === 0) {
                await new Promise((resolve) => setTimeout(resolve, replica));
            }
            const { id, vector } = data[i];
            index.upsert(id, vector, { ordinal: i });
        }
    }));

    const expected = replicas[0].serialize();
    assert.deepEqual(replicas[1].serialize(), expected);
    assert.deepEqual(replicas[2].serialize(), expected);
});

test('snapshot round-trip can continue applying without changing the result', () => {
    const dim = 24;
    const config = { dim, M: 12, efConstruction: 96, mL: 1 / Math.log(12) };
    const data = corpus(240, dim, 37);
    const control = new HnswIndex(config);
    const checkpointed = new HnswIndex(config);

    const put = (index, item, ordinal) =>
        index.upsert(item.id, item.vector, { ordinal, source: 'snapshot-test' });

    data.forEach((item, i) => put(control, item, i));
    data.slice(0, 140).forEach((item, i) => put(checkpointed, item, i));

    const snapshot = checkpointed.serialize();
    const restored = HnswIndex.deserialize(snapshot, config);
    assert.deepEqual(restored.serialize(), snapshot, 'load must preserve canonical bytes');

    data.slice(140).forEach((item, offset) => put(restored, item, offset + 140));
    for (const index of [control, restored]) {
        index.delete('doc-3');
        index.upsert('doc-7', data[211].vector, { ordinal: 241, source: 'replacement' });
    }

    assert.deepEqual(restored.serialize(), control.serialize());
    assert.throws(
        () => HnswIndex.deserialize(snapshot, {
            ...config,
            M: 8,
            mL: 1 / Math.log(8),
        }),
        /parameter mismatch for M/,
    );
});

test('equal distances are ordered by vector id in every candidate path', () => {
    const index = new HnswIndex({ dim: 4, M: 4, efConstruction: 16 });
    const vector = [1, 0, 0, 0];
    const insertionOrder = ['zeta', 'alpha', 'mu', 'beta'];
    for (const id of insertionOrder) index.upsert(id, vector);

    const expected = [...insertionOrder].sort();
    assert.deepEqual(
        index.searchExact(vector, insertionOrder.length).map((hit) => hit.id),
        expected,
    );
    assert.deepEqual(
        index.search(vector, insertionOrder.length, 16).map((hit) => hit.id),
        expected,
    );
});
test('insertion order changes the graph, so the log order is what replicas agree on', () => {
    // Worth asserting explicitly: it is *not* enough for replicas to hold the
    // same vectors. They must apply them in the same order, which is precisely
    // what the replicated log provides and what makes consensus load-bearing
    // here rather than decorative.
    const dim = 32;
    const data = corpus(200, dim, 17);
    const forward = new HnswIndex({ dim });
    const reversed = new HnswIndex({ dim });

    for (const { id, vector } of data) forward.upsert(id, vector);
    for (const { id, vector } of [...data].reverse()) reversed.upsert(id, vector);

    assert.notEqual(forward.fingerprint(), reversed.fingerprint());
    assert.equal(forward.size, reversed.size);
});

test('deletes tombstone without breaking navigability', () => {
    const dim = 32;
    const index = new HnswIndex({ dim, M: 16, efConstruction: 120 });
    const data = corpus(400, dim, 23);
    for (const { id, vector } of data) index.upsert(id, vector);

    for (let i = 0; i < 400; i += 4) assert.equal(index.delete(`doc-${i}`), true);
    assert.equal(index.size, 300);
    assert.equal(index.tombstones, 100);

    // Deleted ids must never surface, and the graph must still route around
    // the holes — tombstoned nodes are kept as waypoints precisely so it can.
    let total = 0;
    const queries = corpus(20, dim, 31);
    for (const q of queries) {
        const hits = index.search(q.vector, 10, 128);
        for (const hit of hits) {
            assert.ok(!hit.id.match(/^doc-(\d+)$/) || Number(hit.id.slice(4)) % 4 !== 0,
                `deleted ${hit.id} was returned`);
        }
        total += recallAt(hits, index.searchExact(q.vector, 10));
    }
    const recall = total / queries.length;
    console.log(`      recall@10 after deleting 25% = ${(recall * 100).toFixed(1)}%`);
    assert.ok(recall >= 0.85, `recall collapsed to ${recall} after deletions`);
});


test('deleting the entry-point hub keeps it as a waypoint but never returns it', () => {
    const dim = 24;
    const index = new HnswIndex({ dim, M: 12, efConstruction: 96 });
    const data = corpus(180, dim, 47);
    for (const item of data) index.upsert(item.id, item.vector);

    const hubId = index.ids[index.entryPoint];
    assert.equal(index.delete(hubId), true);

    for (let i = 0; i < data.length; i += 17) {
        if (data[i].id === hubId) continue;
        const hits = index.search(data[i].vector, 1, data.length);
        assert.equal(hits.length, 1);
        assert.equal(hits[0].id, data[i].id,
            'a remaining node became unreachable after deleting the hub');
        assert.notEqual(hits[0].id, hubId);
    }
});

test('checksum detects a deliberately divergent vector mutation', () => {
    const dim = 16;
    const data = corpus(80, dim, 53);
    const a = new HnswIndex({ dim, M: 8, efConstruction: 64 });
    const b = new HnswIndex({ dim, M: 8, efConstruction: 64 });
    for (const item of data) {
        a.upsert(item.id, item.vector, { ordinal: item.id });
        b.upsert(item.id, item.vector, { ordinal: item.id });
    }

    assert.equal(a.checksum(), b.checksum());
    b.vectors[0][0] += 0.125;
    assert.notEqual(a.checksum(), b.checksum());
});
test('upsert replaces rather than duplicating', () => {
    const index = new HnswIndex({ dim: 8 });
    index.upsert('a', Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]), { v: 1 });
    index.upsert('a', Float32Array.from([0, 1, 0, 0, 0, 0, 0, 0]), { v: 2 });

    assert.equal(index.size, 1);
    const hits = index.search(Float32Array.from([0, 1, 0, 0, 0, 0, 0, 0]), 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 'a');
    assert.deepEqual(hits[0].payload, { v: 2 }, 'the old version should be unreachable');
});

test('normalisation leaves a zero vector alone instead of producing NaNs', () => {
    const index = new HnswIndex({ dim: 4 });
    index.upsert('zero', Float32Array.from([0, 0, 0, 0]));
    index.upsert('one', Float32Array.from([1, 1, 1, 1]));
    const hits = index.search(Float32Array.from([1, 1, 1, 1]), 2);
    assert.equal(hits[0].id, 'one');
    assert.ok(hits.every((h) => Number.isFinite(h.score)), 'a NaN score poisons every comparison');
});
