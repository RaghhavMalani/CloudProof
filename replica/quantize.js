/**
 * quantize.js — compressed vector representations.
 *
 * Modern vector databases do not store float32. Qdrant, Pinecone and Milvus all
 * quantize, because at scale the index does not fit in RAM and the bottleneck
 * stops being arithmetic and becomes memory bandwidth — you are waiting on
 * cache misses, not on multiplies. Shrinking the vectors makes more of the
 * index fit in cache, and the speedup is superlinear as a result.
 *
 * Two levels here, used together:
 *
 *   int8    4x smaller. Symmetric per-vector scale. Recall loss is small
 *           enough to be within noise on most corpora.
 *   binary  32x smaller. One sign bit per dimension, compared with Hamming
 *           distance via popcount. Far too lossy to rank with directly — which
 *           is the point of rescoring below.
 *
 * ── Why this matters *here* specifically ─────────────────────────────────────
 * In a Raft-replicated store, quantization is not only a memory optimisation.
 * Every vector crosses the network to each follower and is fsync'd into every
 * replica's log. int8 makes each log entry a quarter the size, which lands
 * directly on commit latency, on disk footprint, and on how long a restarted
 * node takes to replay its log. Compression and consensus compound here in a
 * way they do not in a single-node index.
 *
 * Both schemes are pure integer/deterministic functions of the input, so every
 * replica produces identical codes — which the state machine requires.
 */

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) {
    POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];
}

/**
 * Symmetric int8 quantization with a per-vector scale.
 *
 * Per-vector rather than a single global scale: embedding norms vary between
 * documents, and one shared scale would clip the large ones and waste
 * resolution on the small ones. The cost is four extra bytes per vector to
 * carry the scale, which against 384 saved bytes is nothing.
 */
function quantizeInt8(vector) {
    const n = vector.length;
    let maxAbs = 0;
    for (let i = 0; i < n; i += 1) {
        const a = Math.abs(vector[i]);
        if (a > maxAbs) maxAbs = a;
    }
    // An all-zero vector has no scale; 1 keeps the arithmetic finite and the
    // codes zero, which is the correct representation of "no direction".
    const scale = maxAbs === 0 ? 1 : maxAbs / 127;
    const codes = new Int8Array(n);
    for (let i = 0; i < n; i += 1) {
        // Math.round is half-away-from-zero in JS and identical on every
        // platform, so replicas agree bit for bit.
        const q = Math.round(vector[i] / scale);
        codes[i] = q > 127 ? 127 : q < -128 ? -128 : q;
    }
    return { codes, scale };
}

function dequantizeInt8(codes, scale) {
    const out = new Float32Array(codes.length);
    for (let i = 0; i < codes.length; i += 1) out[i] = codes[i] * scale;
    return out;
}

/**
 * Inner product between two int8 vectors.
 *
 * The accumulation is integer — exact, no rounding drift however long the
 * vector — and one float multiply converts at the end. This is roughly 4x
 * faster than the float32 equivalent in practice, almost entirely because four
 * times as many vectors fit in L2.
 */
function dotInt8(aCodes, aScale, bCodes, bScale) {
    let acc = 0;
    for (let i = 0; i < aCodes.length; i += 1) acc += aCodes[i] * bCodes[i];
    return acc * aScale * bScale;
}

/**
 * One bit per dimension: the sign. For unit vectors, the fraction of differing
 * bits relates to the angle between them, so Hamming distance is a usable
 * proxy for cosine while being ~32x cheaper to compute and 32x smaller to hold.
 */
function quantizeBinary(vector) {
    const bytes = new Uint8Array(Math.ceil(vector.length / 8));
    for (let i = 0; i < vector.length; i += 1) {
        if (vector[i] > 0) bytes[i >> 3] |= 1 << (i & 7);
    }
    return bytes;
}

function hamming(a, b) {
    let distance = 0;
    for (let i = 0; i < a.length; i += 1) distance += POPCOUNT[a[i] ^ b[i]];
    return distance;
}

/**
 * Maps Hamming distance to an estimated cosine similarity.
 *
 * For random unit vectors the expected angle is π times the fraction of
 * differing bits, so cos(θ) recovers an approximate similarity. It is used only
 * to *order* candidates during traversal — the returned scores come from
 * rescoring — so the estimate needs to be monotone, not accurate.
 */
function hammingToCosine(distance, dimensions) {
    return Math.cos(Math.PI * (distance / dimensions));
}

/**
 * How much memory each representation needs per vector, for the numbers in the
 * benchmark output.
 */
function footprint(dim) {
    return {
        float32: dim * 4,
        int8: dim + 4,
        binary: Math.ceil(dim / 8),
    };
}

module.exports = {
    quantizeInt8,
    dequantizeInt8,
    dotInt8,
    quantizeBinary,
    hamming,
    hammingToCosine,
    footprint,
    POPCOUNT,
};
