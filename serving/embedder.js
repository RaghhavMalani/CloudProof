/**
 * embedder.js — text to vector, in-process.
 *
 * ── Why the embedder does not have to be deterministic ───────────────────────
 * This is the design point worth understanding, because the obvious
 * architecture gets it wrong.
 *
 * The obvious version replicates the *text* through the Raft log and has every
 * replica embed it locally. That makes state agreement depend on every node
 * producing bitwise-identical floats — across ONNX Runtime versions, across
 * SIMD kernels, across x86 and ARM. It very nearly works, which is what makes
 * it dangerous: the vectors differ in the last few bits, the HNSW graphs
 * diverge, and two replicas quietly return different neighbours for the same
 * query with nothing in any log to explain it.
 *
 * Here the leader embeds once and replicates the resulting vector. Consequences
 * worth stating out loud:
 *
 *   - replica agreement is bit-exact by construction, not by hoping two
 *     machines agree on floating point
 *   - followers need no model loaded at all to stay perfectly consistent
 *   - the model can be swapped without touching the consensus layer, because
 *     old vectors already in the log are unaffected
 *   - the cost is that re-embedding an existing corpus means rewriting it
 *     through the log, which is the honest price of the guarantee
 *
 * Two backends, same interface:
 *
 *   onnx   all-MiniLM-L6-v2 via onnxruntime-node, 384-dim, CPU, no API key
 *   hash   a seeded random projection over a token histogram
 *
 * The hash backend is not a mock to be replaced later — it is a working
 * embedder with poor semantics, which keeps the whole pipeline runnable with no
 * model download. Anything measured through it about *plumbing* (latency,
 * replication, recall of the index against its own exact search) is real.
 * Anything about *semantics* is not.
 */

const crypto = require('crypto');
const path = require('path');

const DEFAULT_DIM = 384;

class HashEmbedder {
    constructor({ dim = DEFAULT_DIM, seed = 'miniraft' } = {}) {
        this.dim = dim;
        this.backend = 'hash';
        this.seed = seed;
        this._cache = new Map();
    }

    async init() { return this; }

    /**
     * Hashed token histogram projected onto a fixed random basis. Related
     * strings that share tokens land near each other, which is enough for the
     * index to be exercised meaningfully; unrelated strings that share no
     * tokens are simply orthogonal, with none of the semantic structure a real
     * encoder provides.
     */
    embed(text) {
        const out = new Float32Array(this.dim);
        const tokens = String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        if (tokens.length === 0) return out;

        for (const token of tokens) {
            let basis = this._cache.get(token);
            if (!basis) {
                // A digest gives a stable pseudo-random basis per token without
                // storing a vocabulary.
                const digest = crypto.createHash('sha256').update(`${this.seed}:${token}`).digest();
                basis = new Float32Array(this.dim);
                for (let i = 0; i < this.dim; i += 1) {
                    // Two bytes per dimension, centred and scaled.
                    const byte = digest[(i * 2) % digest.length] << 8 | digest[(i * 2 + 1) % digest.length];
                    basis[i] = (byte / 32767.5) - 1;
                }
                if (this._cache.size < 50000) this._cache.set(token, basis);
            }
            for (let i = 0; i < this.dim; i += 1) out[i] += basis[i];
        }

        let norm = 0;
        for (let i = 0; i < this.dim; i += 1) norm += out[i] * out[i];
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < this.dim; i += 1) out[i] /= norm;
        return out;
    }

    async embedBatch(texts) { return texts.map((t) => this.embed(t)); }
}

/**
 * all-MiniLM-L6-v2 through onnxruntime-node.
 *
 * Chosen because it is 22M parameters, runs comfortably on CPU, needs no API
 * key, and produces 384-dim vectors — small enough that a log entry carrying
 * one stays reasonable. Mean pooling over the token embeddings then L2
 * normalisation is what the sentence-transformers reference implementation
 * does, and getting that wrong is the usual reason a self-hosted MiniLM scores
 * worse than the published numbers.
 */
class OnnxEmbedder {
    constructor({ modelDir, dim = DEFAULT_DIM, maxTokens = 256 } = {}) {
        this.modelDir = modelDir;
        this.dim = dim;
        this.maxTokens = maxTokens;
        this.backend = 'onnx';
        this.session = null;
        this.vocab = null;
    }

    async init() {
        const ort = require('onnxruntime-node');
        const fs = require('fs/promises');

        const modelPath = path.join(this.modelDir, 'model.onnx');
        const vocabPath = path.join(this.modelDir, 'vocab.txt');
        await fs.access(modelPath);

        this.session = await ort.InferenceSession.create(modelPath, {
            // Single-threaded on purpose. The serving pods are CPU-limited and
            // sized small, so letting ORT spawn a thread per core makes it
            // fight the cgroup quota and end up slower than one thread.
            intraOpNumThreads: 1,
            interOpNumThreads: 1,
            graphOptimizationLevel: 'all',
        });

        const vocabText = await fs.readFile(vocabPath, 'utf8');
        this.vocab = new Map(vocabText.split('\n').map((token, i) => [token.trim(), i]));
        this._ort = ort;
        return this;
    }

    /** Greedy longest-match WordPiece, which is what BERT tokenisers use. */
    _tokenize(text) {
        const cls = this.vocab.get('[CLS]') ?? 101;
        const sep = this.vocab.get('[SEP]') ?? 102;
        const unk = this.vocab.get('[UNK]') ?? 100;
        const ids = [cls];

        for (const word of String(text).toLowerCase().split(/\s+/).filter(Boolean)) {
            let start = 0;
            while (start < word.length && ids.length < this.maxTokens - 1) {
                let end = word.length;
                let matched = null;
                while (end > start) {
                    const piece = start === 0 ? word.slice(start, end) : `##${word.slice(start, end)}`;
                    if (this.vocab.has(piece)) { matched = this.vocab.get(piece); break; }
                    end -= 1;
                }
                if (matched === null) { ids.push(unk); break; }
                ids.push(matched);
                start = end;
            }
        }

        ids.push(sep);
        return ids.slice(0, this.maxTokens);
    }

    async embed(text) {
        const ids = this._tokenize(text);
        const tensor = (data) => new this._ort.Tensor('int64', BigInt64Array.from(data.map(BigInt)), [1, ids.length]);

        const output = await this.session.run({
            input_ids: tensor(ids),
            attention_mask: tensor(ids.map(() => 1)),
            token_type_ids: tensor(ids.map(() => 0)),
        });

        const hidden = output.last_hidden_state ?? Object.values(output)[0];
        const [, tokens, dim] = hidden.dims;
        const data = hidden.data;

        // Mean pooling across tokens. Every token is attended here because the
        // input is a single unpadded sequence; with batching this must be
        // weighted by the attention mask or padding drags the vector toward
        // zero.
        const pooled = new Float32Array(dim);
        for (let t = 0; t < tokens; t += 1) {
            for (let d = 0; d < dim; d += 1) pooled[d] += data[t * dim + d];
        }
        let norm = 0;
        for (let d = 0; d < dim; d += 1) { pooled[d] /= tokens; norm += pooled[d] * pooled[d]; }
        norm = Math.sqrt(norm) || 1;
        for (let d = 0; d < dim; d += 1) pooled[d] /= norm;
        return pooled;
    }

    async embedBatch(texts) {
        const out = [];
        for (const text of texts) out.push(await this.embed(text));
        return out;
    }
}

/**
 * Picks a backend, preferring ONNX and falling back loudly.
 *
 * The fallback is announced rather than silent: a demo that quietly degrades to
 * hash embeddings and reports semantic recall numbers would be actively
 * misleading, and the whole point of the measured claims in this project is
 * that they are checkable.
 */
async function createEmbedder(env = process.env) {
    const dim = Number(env.EMBED_DIM || DEFAULT_DIM);
    const modelDir = env.ONNX_MODEL_DIR || path.join(process.cwd(), 'models', 'all-MiniLM-L6-v2');

    if (env.EMBEDDER !== 'hash') {
        try {
            const embedder = await new OnnxEmbedder({ modelDir, dim }).init();
            console.log(`[embedder] onnx · all-MiniLM-L6-v2 · ${dim}d · ${modelDir}`);
            return embedder;
        } catch (error) {
            console.warn(
                `[embedder] ONNX unavailable (${error.message.split('\n')[0]}) — ` +
                'falling back to hash embeddings. Semantic quality is NOT representative; ' +
                'see tools/fetch-model.sh to install the real model.',
            );
        }
    }

    const embedder = await new HashEmbedder({ dim }).init();
    console.log(`[embedder] hash · ${dim}d · deterministic, non-semantic`);
    return embedder;
}

module.exports = { createEmbedder, HashEmbedder, OnnxEmbedder, DEFAULT_DIM };
