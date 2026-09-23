/**
 * artifacts.js — fetching and verifying model and index artifacts.
 *
 * Artifacts live in S3, not in the Raft log. The log holds a manifest — a
 * version string, an object key and a checksum — and nothing else. That split
 * is the whole reason this design works: consensus is for small ordered facts
 * that everyone must agree on, and a 600MB checkpoint is none of those things.
 * Putting the bytes in object storage keeps the log small enough to fsync on
 * every append, which is what makes the append cheap enough to do at all.
 *
 * The local filesystem backend is not a mock for convenience: it is the same
 * code path with a different source, so the lab measures real read, real
 * checksum and real parse. Only the transport differs.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/** Reads artifacts from a directory. Used by the local lab. */
class LocalBackend {
    constructor(root) {
        this.root = root;
        this.kind = 'local';
    }

    async read(key) {
        return fsp.readFile(path.join(this.root, key));
    }

    async stat(key) {
        const info = await fsp.stat(path.join(this.root, key));
        return { size: info.size };
    }
}

/**
 * Reads artifacts from S3.
 *
 * Credentials come from IRSA — the pod's service account is bound to an IAM
 * role through the cluster's OIDC provider, and the SDK picks that up from the
 * projected token automatically. There is nothing to configure here, and on
 * Fargate there is no node instance profile to fall back to, so this is the
 * only mechanism that works.
 */
class S3Backend {
    constructor(bucket, region, { endpoint = null, forcePathStyle = false, credentials = null } = {}) {
        this.bucket = bucket;
        this.region = region;
        this.endpoint = endpoint;
        this.forcePathStyle = forcePathStyle;
        this.credentials = credentials;
        this.kind = endpoint ? 's3-compatible' : 's3';
        this._client = null;
    }

    async _connect() {
        if (this._client) return this._client;
        // Required lazily so the local lab does not need the AWS SDK installed
        // and, more usefully, so SDK load time lands in the measured phase it
        // actually belongs to rather than in process start.
        const { S3Client } = require('@aws-sdk/client-s3');
        this._client = new S3Client({
            region: this.region,
            // Pointing at MinIO exercises the real SDK, the real request
            // signing and the real streaming response handler — the whole code
            // path except the network in between. What it does not reproduce is
            // S3's latency or its bill, so cold-start numbers taken against
            // MinIO are a lower bound, not a forecast.
            ...(this.endpoint ? { endpoint: this.endpoint, forcePathStyle: true } : {}),
            ...(this.forcePathStyle ? { forcePathStyle: true } : {}),
            // Omitted against real AWS so the SDK picks up IRSA from the
            // projected service-account token. Only MinIO needs static keys.
            ...(this.credentials ? { credentials: this.credentials } : {}),
        });
        return this._client;
    }

    async write(key, body) {
        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        const client = await this._connect();
        await client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }));
    }

    async ensureBucket() {
        const { CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
        const client = await this._connect();
        try {
            await client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        } catch (_) {
            await client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        }
    }

    async read(key) {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const client = await this._connect();
        const response = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
        const chunks = [];
        for await (const chunk of response.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
    }

    async stat(key) {
        const { HeadObjectCommand } = require('@aws-sdk/client-s3');
        const client = await this._connect();
        const response = await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
        return { size: response.ContentLength };
    }
}

/**
 * Three deployment shapes, one code path:
 *
 *   ARTIFACT_DIR                 local processes reading a directory
 *   ARTIFACT_BUCKET + ENDPOINT   MinIO in kind — real SDK, local network
 *   ARTIFACT_BUCKET alone        S3 on EKS, credentials from IRSA
 *
 * The middle one is what makes a free local cluster worth building: everything
 * above the network boundary is identical to production, so a bug in request
 * signing, streaming or error handling shows up on a laptop rather than after
 * the first `terraform apply`.
 */
function backendFromEnv(env = process.env) {
    if (env.ARTIFACT_BUCKET) {
        const endpoint = env.S3_ENDPOINT || null;
        const credentials = env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
            ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
            : null;
        return new S3Backend(env.ARTIFACT_BUCKET, env.AWS_REGION || 'ap-south-1', {
            endpoint,
            forcePathStyle: Boolean(endpoint),
            credentials,
        });
    }
    return new LocalBackend(env.ARTIFACT_DIR || path.join(process.cwd(), 'artifacts'));
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * A loaded, ready-to-serve model plus its index shard.
 *
 * The model and the shard are versioned together and loaded together. They
 * have to be: an embedding produced by model v2 is a point in a different
 * vector space from one produced by v1, so searching a v1 index with a v2 query
 * vector returns confident nonsense rather than an error. Coupling them in one
 * object makes it impossible to hold a mismatched pair.
 */
class LoadedModel {
    constructor({ version, dim, weights, shard, sizeBytes, timings }) {
        this.version = version;
        this.dim = dim;
        this.weights = weights;
        this.shard = shard;
        this.sizeBytes = sizeBytes;
        this.timings = timings;
        this.loadedAt = Date.now();
    }

    /**
     * A deterministic stand-in for a real encoder: a fixed random projection of
     * a hashed token histogram. Same interface as a CLIP text tower — text in,
     * unit-norm vector of `dim` out — so replacing this with a real encoder
     * touches this method and nothing else.
     */
    embed(text) {
        const out = new Float32Array(this.dim);
        const tokens = String(text).toLowerCase().split(/\W+/).filter(Boolean);
        for (const token of tokens) {
            let h = 2166136261;
            for (let i = 0; i < token.length; i += 1) {
                h ^= token.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
            const row = (h >>> 0) % this.weights.rows;
            const offset = row * this.dim;
            for (let d = 0; d < this.dim; d += 1) out[d] += this.weights.data[offset + d];
        }
        let norm = 0;
        for (let d = 0; d < this.dim; d += 1) norm += out[d] * out[d];
        norm = Math.sqrt(norm) || 1;
        for (let d = 0; d < this.dim; d += 1) out[d] /= norm;
        return out;
    }

    /** Exact inner-product search over this pod's shard. */
    search(queryVector, topK = 5) {
        const { ids, vectors, count } = this.shard;
        const scored = [];
        for (let i = 0; i < count; i += 1) {
            const offset = i * this.dim;
            let score = 0;
            for (let d = 0; d < this.dim; d += 1) score += queryVector[d] * vectors[offset + d];
            scored.push({ id: ids[i], score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    }
}

/**
 * Fetches, verifies and parses one version.
 *
 * Each phase is timed separately, because the total is the least useful number
 * here. "Cold start is 14 seconds" prompts no action; "12 of those 14 seconds
 * are weight load, and 1.5 is checksum" tells you to bake the weights into the
 * image and to consider whether the checksum is worth its cost.
 */
async function loadVersion(backend, manifest, { shardId = 0, verify = true } = {}) {
    const timings = {};
    const mark = async (phase, fn) => {
        const startedAt = process.hrtime.bigint();
        const value = await fn();
        timings[phase] = Number(process.hrtime.bigint() - startedAt) / 1e6;
        return value;
    };

    const modelKey = `index/${manifest.version}/model.bin`;
    const shardKey = `index/${manifest.version}/shard-${shardId}.bin`;

    const modelBuffer = await mark('fetchWeights', () => backend.read(modelKey));
    const shardBuffer = await mark('fetchShard', () => backend.read(shardKey));

    await mark('verify', async () => {
        if (!verify || !manifest.sha256) return;
        const expectedModel = manifest.sha256[`model`];
        const expectedShard = manifest.sha256[`shard-${shardId}`];
        // A corrupt artifact that loads without complaint is worse than one
        // that fails: the pod would serve plausible, wrong results and nothing
        // would page. Verification is why the manifest carries checksums at all.
        if (expectedModel && sha256(modelBuffer) !== expectedModel) {
            throw new Error(`checksum mismatch on ${modelKey}`);
        }
        if (expectedShard && sha256(shardBuffer) !== expectedShard) {
            throw new Error(`checksum mismatch on ${shardKey}`);
        }
    });

    const parsed = await mark('parse', async () => {
        const weights = decodeMatrix(modelBuffer);
        const shard = decodeShard(shardBuffer);
        if (weights.cols !== manifest.dim || shard.dim !== manifest.dim) {
            throw new Error(
                `dimension mismatch: manifest says ${manifest.dim}, ` +
                `weights are ${weights.cols}, shard is ${shard.dim}`,
            );
        }
        return { weights, shard };
    });

    return new LoadedModel({
        version: manifest.version,
        dim: manifest.dim,
        weights: { rows: parsed.weights.rows, data: parsed.weights.data },
        shard: parsed.shard,
        sizeBytes: modelBuffer.length + shardBuffer.length,
        timings,
    });
}

// ── binary format ────────────────────────────────────────────────────────────
// Deliberately trivial: a 16-byte header then raw little-endian float32. Real
// checkpoints are not this simple, but the cost that matters — moving bytes and
// materialising typed arrays — is the same shape.

const MAGIC = 0x4d524654; // "MRFT"

function encodeMatrix(rows, cols, data) {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(MAGIC, 0);
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(rows, 8);
    header.writeUInt32LE(cols, 12);
    return Buffer.concat([header, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
}

function decodeMatrix(buffer) {
    if (buffer.readUInt32LE(0) !== MAGIC) throw new Error('not a CloudProof artifact');
    const rows = buffer.readUInt32LE(8);
    const cols = buffer.readUInt32LE(12);
    const body = buffer.subarray(16);
    // Copy rather than view: a Buffer from a pooled allocation may not be
    // 4-byte aligned, and Float32Array over a misaligned offset throws.
    const data = new Float32Array(rows * cols);
    Buffer.from(data.buffer).set(body.subarray(0, data.byteLength));
    return { rows, cols, data };
}

function encodeShard(ids, dim, vectors) {
    const idBuffer = Buffer.from(`${JSON.stringify(ids)}\n`, 'utf8');
    const header = Buffer.alloc(16);
    header.writeUInt32LE(MAGIC, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(idBuffer.length, 8);
    header.writeUInt32LE(dim, 12);
    return Buffer.concat([
        header,
        idBuffer,
        Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength),
    ]);
}

function decodeShard(buffer) {
    if (buffer.readUInt32LE(0) !== MAGIC) throw new Error('not a CloudProof artifact');
    const idLength = buffer.readUInt32LE(8);
    const dim = buffer.readUInt32LE(12);
    const ids = JSON.parse(buffer.subarray(16, 16 + idLength).toString('utf8'));
    const body = buffer.subarray(16 + idLength);
    const vectors = new Float32Array(ids.length * dim);
    Buffer.from(vectors.buffer).set(body.subarray(0, vectors.byteLength));
    return { ids, dim, vectors, count: ids.length };
}

module.exports = {
    LocalBackend,
    S3Backend,
    LoadedModel,
    backendFromEnv,
    loadVersion,
    sha256,
    encodeMatrix,
    decodeMatrix,
    encodeShard,
    decodeShard,
};
