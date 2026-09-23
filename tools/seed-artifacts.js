#!/usr/bin/env node
/**
 * seed-artifacts.js — builds artifact versions and uploads them to S3/MinIO.
 *
 * Runs as a Job inside the cluster rather than as a script on the host, so no
 * artifact bytes ever have to be copied in. Generation is deterministic from
 * the version string, so re-running produces byte-identical objects and the
 * checksums in the manifest stay valid.
 *
 *   ARTIFACT_BUCKET=cloudproof-artifacts S3_ENDPOINT=http://minio.minio.svc:9000 \
 *   SEED_VERSIONS=v1,v2 node tools/seed-artifacts.js
 */

const crypto = require('crypto');
const path = require('path');

const { backendFromEnv, encodeMatrix, encodeShard, sha256 } = require('../serving/artifacts');

const VERSIONS = (process.env.SEED_VERSIONS || 'v1,v2').split(',').filter(Boolean);
const DIM = Number(process.env.SEED_DIM || 128);
const ROWS = Number(process.env.SEED_ROWS || 8192);
const SHARDS = Number(process.env.SEED_SHARDS || 3);
const VECTORS = Number(process.env.SEED_VECTORS || 2000);

function makeRandom(seed) {
    let s = seed >>> 0;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return (s / 0xffffffff) * 2 - 1;
    };
}

function buildVersion(version) {
    // Seeded from the version string so v1 and v2 are genuinely different
    // vector spaces — the property the rollout demo depends on.
    const seed = 1 + [...version].reduce((a, c) => a + c.charCodeAt(0), 0);
    const random = makeRandom(seed);

    const weights = new Float32Array(ROWS * DIM);
    for (let i = 0; i < weights.length; i += 1) weights[i] = random() * 0.05;
    const model = encodeMatrix(ROWS, DIM, weights);

    const objects = [{ key: `index/${version}/model.bin`, body: model }];
    const checksums = { model: sha256(model) };

    for (let shard = 0; shard < SHARDS; shard += 1) {
        const ids = Array.from({ length: VECTORS }, (_, i) => `doc-${shard}-${i}`);
        const vectors = new Float32Array(VECTORS * DIM);
        for (let i = 0; i < VECTORS; i += 1) {
            let norm = 0;
            for (let d = 0; d < DIM; d += 1) {
                const value = random();
                vectors[i * DIM + d] = value;
                norm += value * value;
            }
            norm = Math.sqrt(norm) || 1;
            for (let d = 0; d < DIM; d += 1) vectors[i * DIM + d] /= norm;
        }
        const body = encodeShard(ids, DIM, vectors);
        objects.push({ key: `index/${version}/shard-${shard}.bin`, body });
        checksums[`shard-${shard}`] = sha256(body);
    }

    const manifest = { version, dim: DIM, shards: SHARDS, sha256: checksums, builtAt: new Date().toISOString() };
    objects.push({
        key: `index/${version}/manifest.json`,
        body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    });

    return { manifest, objects };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for the object store to answer.
 *
 * This Job and the MinIO Deployment are applied together, so the Job usually
 * wins the race and finds nothing listening. Without this it burns through its
 * backoffLimit in the first fifteen seconds and the whole cluster comes up with
 * no artifacts — which then presents as every serving pod stuck unready, three
 * layers away from the actual cause.
 *
 * Retrying here rather than raising backoffLimit keeps the failure honest: a
 * genuinely broken endpoint still fails, just after a bounded wait instead of
 * immediately.
 */
async function waitForBackend(backend, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    let attempt = 0;

    while (Date.now() < deadline) {
        try {
            await backend.ensureBucket();
            if (attempt > 0) console.log(`  object store ready after ${attempt} retries`);
            return;
        } catch (error) {
            lastError = error;
            attempt += 1;
            if (attempt === 1) console.log('  waiting for the object store…');
            await sleep(Math.min(2000, 250 * attempt));
        }
    }
    throw new Error(`object store never became ready: ${lastError?.message ?? 'unknown'}`);
}

(async () => {
    const backend = backendFromEnv();
    if (typeof backend.write !== 'function') {
        throw new Error('seed requires an S3-compatible backend; set ARTIFACT_BUCKET');
    }

    console.log(`seeding ${VERSIONS.join(', ')} into ${backend.bucket}` +
        `${backend.endpoint ? ` at ${backend.endpoint}` : ' on AWS'}`);

    await waitForBackend(backend);

    for (const version of VERSIONS) {
        const { manifest, objects } = buildVersion(version);
        let bytes = 0;
        for (const object of objects) {
            await backend.write(object.key, object.body);
            bytes += object.body.length;
        }
        console.log(`  ${version}  ${objects.length} objects  ${(bytes / 1e6).toFixed(1)}MB  ` +
            `model sha ${manifest.sha256.model.slice(0, 12)}…`);
    }

    // Read one object back before declaring success. A seed job that uploads
    // but cannot read is a failure that would otherwise surface as every
    // serving pod stuck unready, which is a much worse place to debug it.
    const check = await backend.read(`index/${VERSIONS[0]}/manifest.json`);
    const parsed = JSON.parse(check.toString('utf8'));
    if (parsed.version !== VERSIONS[0]) throw new Error('readback mismatch');
    console.log(`readback verified: ${parsed.version} (${parsed.shards} shards, dim ${parsed.dim})`);
})().catch((error) => {
    console.error(`seed failed: ${error.message}`);
    process.exit(1);
});
