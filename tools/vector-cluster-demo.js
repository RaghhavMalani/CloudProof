#!/usr/bin/env node
/**
 * vector-cluster-demo.js — proves the vector index is genuinely replicated.
 *
 * The claim being tested is the one the whole design rests on: three
 * independent processes, each building its own HNSW graph from nothing but the
 * committed log, end up with byte-identical structures — and keep them
 * identical across a leader failure.
 *
 * Comparing search results alone would be a weak test. Two different graphs
 * agree on easy queries and diverge only on hard ones, so the assertion is made
 * against the structural fingerprint of the graph itself, with query agreement
 * checked on top of it.
 *
 *   node tools/vector-cluster-demo.js
 */

const path = require('path');

const { createEmbedder } = require('../serving/embedder');

const REPLICAS = (process.env.RAFT_REPLICAS_URLS
    || 'http://127.0.0.1:5001,http://127.0.0.1:5002,http://127.0.0.1:5003').split(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
};

const encode = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');

let leaderUrl = REPLICAS[0];

async function write(route, body, method = 'POST', attempt = 0) {
    if (attempt > 12) throw new Error(`no leader for ${route}`);
    let response;
    try {
        response = await fetch(`${leaderUrl}${route}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (_) {
        leaderUrl = REPLICAS[(REPLICAS.indexOf(leaderUrl) + 1) % REPLICAS.length];
        await sleep(120);
        return write(route, body, method, attempt + 1);
    }
    const payload = await response.json().catch(() => ({}));
    if (response.status === 307 || (response.status === 503 && payload.retryable)) {
        leaderUrl = payload.leaderUrl || REPLICAS[(REPLICAS.indexOf(leaderUrl) + 1) % REPLICAS.length];
        await sleep(120);
        return write(route, body, method, attempt + 1);
    }
    return { status: response.status, body: payload };
}

const CORPUS = [
    'a golden retriever running through a field',
    'a small dog playing fetch in the park',
    'a cat sleeping on a windowsill',
    'a tabby kitten chasing a ball of yarn',
    'a red sports car on a mountain road',
    'a vintage motorcycle parked outside a cafe',
    'freshly baked sourdough bread on a wooden board',
    'a bowl of ramen with a soft boiled egg',
    'snow covered peaks at sunrise',
    'a long sandy beach at low tide',
    'a crowded subway platform at rush hour',
    'an empty library reading room',
    'circuit boards under a microscope',
    'a server rack with blinking status lights',
    'handwritten notes beside a cup of coffee',
    'a violin resting on sheet music',
];

(async () => {
    const embedder = await createEmbedder();
    const dim = embedder.dim;

    console.log(`\n--- creating the index through consensus (dim=${dim}) ---`);
    // The seed goes through the log deliberately: passing it as local config
    // would let replicas disagree, and the graphs would silently diverge.
    const created = await write('/index', { dim, M: 16, efConstruction: 200, seed: 0xc0ffee });
    check('index created via a committed entry', created.status === 200 && created.body.ok, created);

    console.log('\n--- upserting vectors through the replicated log ---');
    let upserted = 0;
    for (let i = 0; i < CORPUS.length; i += 1) {
        // Embedding happens HERE, once, on the client side of the leader. Only
        // the resulting vector is replicated — no replica ever sees the text,
        // and none of them needs a model to stay consistent.
        const vector = await embedder.embed(CORPUS[i]);
        const result = await write(`/vectors/doc-${i}`, {
            vector: encode(vector),
            payload: { text: CORPUS[i] },
            clientId: 'demo',
            seqNo: i,
        }, 'PUT');
        if (result.status === 200 && result.body.ok) upserted += 1;
    }
    check(`all ${CORPUS.length} vectors committed`, upserted === CORPUS.length, { upserted });

    await sleep(600); // let followers apply

    // ── the core assertion ───────────────────────────────────────────────────
    console.log('\n--- comparing graphs across replicas ---');
    const stats = [];
    for (const url of REPLICAS) {
        const s = await fetch(`${url}/index`).then((r) => r.json()).catch(() => null);
        stats.push({ url, s });
        console.log(`  ${s?.replicaId ?? url}  size=${s?.size}  edges=${s?.edges}  ` +
            `maxLevel=${s?.maxLevel}  fingerprint=${s?.fingerprint}`);
    }
    const fingerprints = new Set(stats.map((x) => x.s?.fingerprint));
    check('every replica built a byte-identical HNSW graph',
        fingerprints.size === 1 && !fingerprints.has(undefined), [...fingerprints]);

    // ── query agreement, including from followers ────────────────────────────
    console.log('\n--- querying every replica ---');
    const query = await embedder.embed('a puppy playing outside');
    const answers = [];
    for (const url of REPLICAS) {
        const r = await fetch(`${url}/search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ vector: encode(query), k: 5, stale: true }),
        }).then((x) => x.json());
        answers.push(r);
        console.log(`  ${r.replicaId}: ${r.results.map((h) => `${h.id}(${h.score.toFixed(3)})`).join(' ')}`);
    }
    const ids = answers.map((a) => a.results.map((h) => h.id).join(','));
    check('every replica returned identical neighbours', new Set(ids).size === 1, ids);

    // ── recall against exact search, on the live cluster ─────────────────────
    console.log('\n--- recall@k on the running cluster ---');
    let recallTotal = 0;
    const probes = ['a dog outdoors', 'hot food in a bowl', 'computer hardware', 'mountains and snow', 'music'];
    for (const probe of probes) {
        const v = encode(await embedder.embed(probe));
        const approx = await fetch(`${leaderUrl}/search`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ vector: v, k: 5, stale: true }),
        }).then((r) => r.json());
        const exact = await fetch(`${leaderUrl}/search`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ vector: v, k: 5, exact: true, stale: true }),
        }).then((r) => r.json());
        const truth = new Set(exact.results.map((h) => h.id));
        const hit = approx.results.filter((h) => truth.has(h.id)).length;
        recallTotal += hit / Math.max(1, exact.results.length);
        console.log(`  "${probe}" → ${approx.results[0]?.payload?.text ?? '?'}`);
    }
    const recall = recallTotal / probes.length;
    console.log(`  recall@5 vs exact = ${(recall * 100).toFixed(1)}%`);
    check('approximate search matches exact search', recall >= 0.9, { recall });

    // ── linearizability posture ──────────────────────────────────────────────
    const followerUrl = REPLICAS.find((u) => u !== leaderUrl);
    const strict = await fetch(`${followerUrl}/search`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vector: encode(query), k: 3 }),
    });
    check('a linearizable read on a follower is refused', strict.status === 503, strict.status);

    // ── survives a leader failure ────────────────────────────────────────────
    console.log('\n--- pausing the leader ---');
    const before = stats[0].s.fingerprint;
    await fetch(`${leaderUrl}/pause`, { method: 'POST' }).catch(() => {});
    await sleep(2500);

    const newLeader = [];
    for (const url of REPLICAS) {
        const s = await fetch(`${url}/status`).then((r) => r.json()).catch(() => null);
        if (s?.state === 'LEADER') newLeader.push(url);
    }
    check('a new leader was elected', newLeader.length === 1, newLeader);
    if (newLeader[0]) leaderUrl = newLeader[0];

    const extra = await embedder.embed('a husky in the snow');
    const added = await write('/vectors/doc-new', { vector: encode(extra), payload: { text: 'a husky in the snow' } }, 'PUT');
    check('writes continue under the new leader', added.status === 200 && added.body.ok, added);

    await sleep(600);
    const survivors = [];
    for (const url of REPLICAS) {
        const s = await fetch(`${url}/index`).then((r) => r.json()).catch(() => null);
        if (s && s.size === CORPUS.length + 1) survivors.push(s.fingerprint);
    }
    check('surviving replicas still agree after the failover',
        survivors.length >= 2 && new Set(survivors).size === 1, survivors);
    check('the graph actually changed when a vector was added',
        survivors[0] !== before, { before, after: survivors[0] });

    await Promise.all(REPLICAS.map((u) => fetch(`${u}/resume`, { method: 'POST' }).catch(() => {})));
    await sleep(2000);

    const healed = [];
    for (const url of REPLICAS) {
        const s = await fetch(`${url}/index`).then((r) => r.json()).catch(() => null);
        healed.push(s?.fingerprint);
    }
    check('the paused replica catches up to the same graph',
        new Set(healed).size === 1 && !healed.includes(undefined), healed);

    console.log(`\nembedder backend: ${embedder.backend} (${dim}d)`);
    console.log(`${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
    console.error('demo failed:', error);
    process.exit(1);
});
