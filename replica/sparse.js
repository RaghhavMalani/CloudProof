/**
 * sparse.js — BM25 lexical retrieval, and fusion with the dense index.
 *
 * ── Why a vector database needs a keyword index ──────────────────────────────
 * Dense embeddings are very good at meaning and quietly bad at identifiers.
 * A query for `ERR_CONNECTION_REFUSED`, a part number, a person's surname or a
 * function name lands nowhere useful in embedding space, because the encoder
 * has compressed exactly the surface detail the user was searching for. This is
 * not a tuning problem; it is what the representation is for.
 *
 * BM25 has the mirror-image weakness: it cannot match "car" to "automobile".
 * Running both and fusing the rankings is the standard modern answer, and it is
 * what every serious retrieval stack does — Elastic, Vespa, Weaviate, Qdrant
 * all ship it, and the RAG literature consistently shows hybrid beating either
 * half alone.
 *
 * ── Fusion by rank, not by score ─────────────────────────────────────────────
 * The tempting approach is a weighted sum of the two scores. It does not work:
 * cosine similarity lives in [-1, 1] and BM25 is unbounded and corpus-
 * dependent, so any fixed weighting is really a hidden normalisation constant
 * that has to be retuned per corpus, and silently degrades when the corpus
 * changes.
 *
 * Reciprocal Rank Fusion sidesteps this by discarding the scores and using only
 * the positions. It needs no tuning, no normalisation, and no assumption that
 * the two systems' scores are comparable — because it never compares them.
 *
 * Everything here is deterministic, so it replicates through the Raft log with
 * the same guarantees as the dense index.
 */

const K1 = 1.2;   // term-frequency saturation
const B = 0.75;   // length normalisation strength
const RRF_K = 60; // damping constant from the original RRF paper

/** Deliberately simple and deterministic — no stemmer, no locale dependence. */
function tokenize(text) {
    return String(text || '')
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length > 0 && t.length < 40);
}

class BM25Index {
    constructor() {
        /** @type {Map<string, Map<string, number>>} term -> (docId -> term frequency) */
        this.postings = new Map();
        /** @type {Map<string, number>} docId -> token count */
        this.lengths = new Map();
        this.totalLength = 0;
    }

    get size() { return this.lengths.size; }
    get averageLength() { return this.lengths.size === 0 ? 0 : this.totalLength / this.lengths.size; }

    add(id, text) {
        this.remove(id);
        const tokens = tokenize(text);
        if (tokens.length === 0) return;

        const frequencies = new Map();
        for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);

        for (const [term, count] of frequencies) {
            let posting = this.postings.get(term);
            if (!posting) { posting = new Map(); this.postings.set(term, posting); }
            posting.set(id, count);
        }

        this.lengths.set(id, tokens.length);
        this.totalLength += tokens.length;
    }

    remove(id) {
        const length = this.lengths.get(id);
        if (length === undefined) return false;
        this.lengths.delete(id);
        this.totalLength -= length;
        // Postings are pruned eagerly. Leaving tombstones would make idf drift
        // as documents are deleted, which quietly changes the ranking of every
        // remaining document.
        for (const [term, posting] of this.postings) {
            if (posting.delete(id) && posting.size === 0) this.postings.delete(term);
        }
        return true;
    }

    search(query, k = 10, filter = null, payloadOf = null) {
        const terms = tokenize(query);
        if (terms.length === 0 || this.size === 0) return [];

        const N = this.size;
        const avgdl = this.averageLength || 1;
        const scores = new Map();

        for (const term of terms) {
            const posting = this.postings.get(term);
            if (!posting) continue;

            const df = posting.size;
            // Robertson/Sparck Jones idf with the +0.5 smoothing. The outer
            // +1 keeps it positive: without it, a term appearing in more than
            // half the corpus scores negative and actively penalises documents
            // that contain the query term.
            const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

            for (const [id, tf] of posting) {
                if (filter && payloadOf && !filter(payloadOf(id), id)) continue;
                const dl = this.lengths.get(id) || 0;
                const denominator = tf + K1 * (1 - B + B * (dl / avgdl));
                scores.set(id, (scores.get(id) || 0) + idf * ((tf * (K1 + 1)) / denominator));
            }
        }

        return [...scores.entries()]
            // Score descending, id ascending. The id tiebreak matters for the
            // same reason it does in the dense index: replicas must agree on
            // the order of equally-scored documents.
            .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
            .slice(0, k)
            .map(([id, score]) => ({ id, score }));
    }

    stats() {
        return { documents: this.size, terms: this.postings.size, averageLength: Number(this.averageLength.toFixed(1)) };
    }
}

/**
 * Reciprocal Rank Fusion.
 *
 * score(d) = Σ over rankings 1 / (K + rank(d))
 *
 * The constant damps the influence of top positions: without it, first place in
 * either ranking would dominate everything, and hybrid search would collapse
 * back into whichever system happened to be confident. 60 is the value from the
 * original paper and is what everyone ships.
 *
 * `weights` biases toward one retriever without reintroducing score
 * comparability — it scales the rank contribution, not the underlying scores.
 */
function reciprocalRankFusion(rankings, { k = RRF_K, weights = null, limit = 10 } = {}) {
    const fused = new Map();

    rankings.forEach((ranking, source) => {
        const weight = weights ? (weights[source] ?? 1) : 1;
        ranking.forEach((hit, position) => {
            const contribution = weight / (k + position + 1);
            const entry = fused.get(hit.id) || { id: hit.id, score: 0, sources: {}, payload: hit.payload };
            entry.score += contribution;
            entry.sources[source === 0 ? 'dense' : 'sparse'] = { rank: position + 1, score: hit.score };
            if (hit.payload && !entry.payload) entry.payload = hit.payload;
            fused.set(hit.id, entry);
        });
    });

    return [...fused.values()]
        .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1))
        .slice(0, limit);
}

module.exports = { BM25Index, reciprocalRankFusion, tokenize, RRF_K };
