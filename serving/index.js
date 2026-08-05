/**
 * Embedding service — the stateless serving tier.
 *
 * Runs on Fargate. Holds no durable state: everything it needs is either an
 * immutable artifact in S3 or a fact it learned from the Raft cluster. That is
 * what lets it scale to zero and start cold, and it is why the interesting
 * numbers in this project come from this process rather than from the replicas.
 *
 * ── Why the rollout is two-phase ─────────────────────────────────────────────
 * The naive design is one key: pods watch `model/current`, and when it changes
 * they download the new artifact and swap. It looks atomic — one CAS flips one
 * key — but it is not, because the expensive part happens *after* the flip.
 * Each pod takes as long as its download does, so during a rollout the fleet is
 * split between versions for tens of seconds.
 *
 * For embeddings that is not a cosmetic problem. A vector produced by model v2
 * lives in a different space from one produced by v1, so a query that fans out
 * across shards and gets v1 results from one pod and v2 from another is not
 * degraded, it is meaningless — and it fails silently, with plausible scores.
 *
 * So activation is separated from loading:
 *
 *   1. the indexer publishes `model/staged` = manifest
 *   2. every pod preloads that version into a shadow slot, still serving the
 *      old one, then CASes `model/ready/<podId>` = version
 *   3. the controller waits until every live pod has acked, then CASes
 *      `model/current` = version
 *   4. pods see `model/current` change and swap a pointer — no I/O, sub-
 *      millisecond, so the window where the fleet disagrees is tiny
 *
 * Rollback is the same mechanism in reverse and equally fast, because the
 * previous version is still sitting in the retired slot.
 */

// These two must come before any require, or module load time gets attributed
// to whatever phase happens to be measured next. Getting this wrong is easy and
// silently ruins the breakdown: an earlier version of this file took the
// timestamp after `require('express')` and reported 75ms of module load as
// image-pull time.
const PROCESS_STARTED_AT = Date.now();
const BOOT_T0 = Number(process.env.BOOT_T0 || PROCESS_STARTED_AT);

const express = require('express');
const os = require('os');

const { backendFromEnv, loadVersion } = require('./artifacts');
const { ConsensusClient } = require('./consensus-client');

const MODULES_LOADED_AT = Date.now();

const POD_ID = process.env.POD_ID || `${os.hostname()}-${process.pid}`;
const PORT = Number.parseInt(process.env.PORT || '7000', 10);
const SHARD_ID = Number.parseInt(process.env.SHARD_ID || '0', 10);
const REPLICAS = (process.env.RAFT_REPLICAS_URLS
    || 'http://127.0.0.1:5001,http://127.0.0.1:5002,http://127.0.0.1:5003')
    .split(',').filter(Boolean);

// Verification is on by default and should stay on in production: an artifact
// that is corrupt but parseable produces confident, wrong answers and pages
// nobody. The switch exists so the cold-start bench can price what it costs,
// which is the only way to have the argument with numbers.
const VERIFY_ARTIFACTS = process.env.SKIP_VERIFY !== '1';

const backend = backendFromEnv();
const consensus = new ConsensusClient(REPLICAS, { label: POD_ID });

const state = {
    // The pointer every query reads. Swapping it is the activation step.
    active: null,
    // Preloaded and verified, waiting for the fleet to catch up.
    shadow: null,
    // Kept after a flip so a rollback is also just a pointer swap.
    retired: null,
    staged: null,
    lastError: null,
    coldStart: {
        // Everything before this process existed: on Fargate that is sandbox
        // setup and image pull, which the container cannot see. The harness
        // stamps BOOT_T0 outside and passes it in, so this is only populated
        // when something external is measuring.
        preProcessMs: PROCESS_STARTED_AT - BOOT_T0,
        // Node boot plus require graph. Real, and the phase a slimmer
        // dependency tree actually moves.
        runtimeInitMs: null,
        discoverMs: null,
        loadMs: null,
        // Wall-clock offset from boot at which the first query completed, and
        // the duration of that query. The first is for the timeline; the second
        // is what shows JIT and first-touch page cost.
        firstQueryAtMs: null,
        firstQueryMs: null,
        // Wall time from boot to serving. Honest, but only meaningful when a
        // manifest already exists — otherwise it mostly measures how long the
        // operator took to publish one, which is not a property of the pod.
        totalToActiveMs: null,
        // Boot to serving, excluding time spent waiting for a manifest to
        // exist. This is the number to quote for autoscaling: it is what a pod
        // added to an already-running fleet actually costs.
        activeAfterManifestMs: null,
        phases: null,
    },
    manifestSeenAt: null,
    metrics: {
        queries: 0,
        latencySumMs: 0,
        latencyBuckets: { 1: 0, 5: 0, 10: 0, 25: 0, 50: 0, 100: 0, 250: 0 },
        activations: 0,
        preloads: 0,
        preloadFailures: 0,
        rollbacks: 0,
    },
};

state.coldStart.runtimeInitMs = MODULES_LOADED_AT - PROCESS_STARTED_AT;

const log = (message) => console.log(`[${POD_ID}] ${message}`);

// ── model lifecycle ──────────────────────────────────────────────────────────

/**
 * Loads a version into the shadow slot and acknowledges it.
 *
 * Failure here is deliberately non-fatal for queries. A pod that cannot load
 * v2 keeps serving v1 correctly; what it does not do is acknowledge, which
 * stalls the rollout. That is the right failure mode — a stuck rollout is
 * visible and recoverable, a fleet half-serving a broken model is neither.
 */
async function preload(manifest) {
    if (state.shadow?.version === manifest.version) return true;
    if (state.active?.version === manifest.version) return true;

    log(`preloading ${manifest.version}`);
    try {
        const loaded = await loadVersion(backend, manifest, { shardId: SHARD_ID, verify: VERIFY_ARTIFACTS });
        state.shadow = loaded;
        state.metrics.preloads += 1;
        state.lastError = null;

        // An unconditional write, not a CAS. Each pod is the only writer of its
        // own readiness key, so there is no race to guard against — and a CAS
        // here would need a read first, which on a stale follower would produce
        // a phantom conflict and stall the rollout on a pod that is actually
        // fine.
        await consensus.put(`model/ready/${POD_ID}`, manifest.version);

        log(`preloaded ${manifest.version} in ${Object.values(loaded.timings)
            .reduce((a, b) => a + b, 0).toFixed(0)}ms · acked`);
        return true;
    } catch (error) {
        state.metrics.preloadFailures += 1;
        state.lastError = `preload ${manifest.version}: ${error.message}`;
        log(`PRELOAD FAILED ${manifest.version}: ${error.message} — still serving ${state.active?.version ?? 'nothing'}`);
        return false;
    }
}

/**
 * Activation. If the version is already in a slot this is a pointer swap and
 * costs nothing; if it is not — a pod that joined mid-rollout, or missed the
 * staged event — it falls back to loading synchronously, which is slow but
 * correct.
 */
async function activate(manifest) {
    const alreadyActive = state.active?.version === manifest.version;
    if (alreadyActive) return;

    let next = null;
    if (state.shadow?.version === manifest.version) next = state.shadow;
    else if (state.retired?.version === manifest.version) {
        next = state.retired;
        state.metrics.rollbacks += 1;
        log(`rolling back to ${manifest.version} from the retired slot`);
    }

    if (!next) {
        log(`activating ${manifest.version} without a preload — loading synchronously`);
        next = await loadVersion(backend, manifest, { shardId: SHARD_ID, verify: VERIFY_ARTIFACTS });
    }

    const swappedAt = process.hrtime.bigint();
    state.retired = state.active;
    state.active = next;
    if (state.shadow === next) state.shadow = null;
    const swapMs = Number(process.hrtime.bigint() - swappedAt) / 1e6;

    state.metrics.activations += 1;
    if (state.coldStart.totalToActiveMs === null) {
        const now = Date.now();
        state.coldStart.totalToActiveMs = now - BOOT_T0;
        state.coldStart.activeAfterManifestMs = now - (state.manifestSeenAt ?? BOOT_T0);
        state.coldStart.loadMs = Object.values(next.timings).reduce((a, b) => a + b, 0);
        state.coldStart.phases = next.timings;
    }

    log(`ACTIVE ${next.version} · swap took ${swapMs.toFixed(3)}ms`);
}

async function onModelEvent(event) {
    if (event.type === 'delete' || event.value === null) return;

    if (event.key === 'model/staged') {
        state.staged = event.value;
        if (state.manifestSeenAt === null) state.manifestSeenAt = Date.now();
        await preload(event.value);
    } else if (event.key === 'model/current') {
        if (state.manifestSeenAt === null) state.manifestSeenAt = Date.now();
        await activate(event.value);
    }
}

/** Catches up on state that changed before this pod existed. */
async function bootstrap() {
    const discoverStartedAt = Date.now();
    const staged = await consensus.get('model/staged').catch(() => null);
    const current = await consensus.get('model/current').catch(() => null);
    state.coldStart.discoverMs = Date.now() - discoverStartedAt;

    if (staged) {
        state.staged = staged.value;
        await preload(staged.value);
    }
    if (current) {
        await activate(current.value);
    } else {
        log('no model/current yet — will stay unready until one is published');
    }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));

app.post('/search', (req, res) => {
    // Read the pointer exactly once. A request that read it twice could
    // straddle an activation and mix vector spaces within a single response —
    // the precise failure the two-phase rollout exists to prevent.
    const model = state.active;
    if (!model) return res.status(503).json({ error: 'no model loaded' });

    const { query, topK = 5 } = req.body || {};
    if (typeof query !== 'string') return res.status(400).json({ error: 'query must be a string' });

    const startedAt = process.hrtime.bigint();
    const vector = model.embed(query);
    const results = model.search(vector, topK);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    state.metrics.queries += 1;
    state.metrics.latencySumMs += elapsedMs;
    for (const boundary of Object.keys(state.metrics.latencyBuckets).map(Number)) {
        if (elapsedMs <= boundary) state.metrics.latencyBuckets[boundary] += 1;
    }
    if (state.coldStart.firstQueryAtMs === null) {
        state.coldStart.firstQueryAtMs = Date.now() - BOOT_T0;
        state.coldStart.firstQueryMs = Number(elapsedMs.toFixed(3));
    }

    // Every response carries the version that produced it. This is what makes
    // the rollout verifiable from outside: a client can prove it never received
    // a mixed answer.
    res.json({
        modelVersion: model.version,
        shardId: SHARD_ID,
        podId: POD_ID,
        latencyMs: Number(elapsedMs.toFixed(3)),
        results,
    });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, podId: POD_ID }));

// Ready means "can serve a correct answer", not "process is up". A pod with no
// active model is running fine and must still be kept out of the load balancer.
app.get('/readyz', (_req, res) => {
    const ready = state.active !== null;
    res.status(ready ? 200 : 503).json({
        ready,
        active: state.active?.version ?? null,
        shadow: state.shadow?.version ?? null,
        lastError: state.lastError,
    });
});

app.get('/status', (_req, res) => {
    res.json({
        podId: POD_ID,
        shardId: SHARD_ID,
        active: state.active?.version ?? null,
        shadow: state.shadow?.version ?? null,
        retired: state.retired?.version ?? null,
        staged: state.staged?.version ?? null,
        backend: backend.kind,
        coldStart: state.coldStart,
        metrics: state.metrics,
        consensus: consensus.stats,
        lastError: state.lastError,
    });
});

app.get('/metrics', (_req, res) => {
    const labels = `pod="${POD_ID}",shard="${SHARD_ID}"`;
    const lines = [
        '# HELP embedding_queries_total Queries served.',
        '# TYPE embedding_queries_total counter',
        `embedding_queries_total{${labels}} ${state.metrics.queries}`,
        '# HELP embedding_activations_total Model activations on this pod.',
        '# TYPE embedding_activations_total counter',
        `embedding_activations_total{${labels}} ${state.metrics.activations}`,
        '# HELP embedding_preload_failures_total Failed shadow-slot preloads.',
        '# TYPE embedding_preload_failures_total counter',
        `embedding_preload_failures_total{${labels}} ${state.metrics.preloadFailures}`,
        '# HELP embedding_cold_start_ms Boot to first activation, by phase.',
        '# TYPE embedding_cold_start_ms gauge',
        `embedding_cold_start_ms{${labels},phase="total"} ${state.coldStart.totalToActiveMs ?? 0}`,
        `embedding_cold_start_ms{${labels},phase="pre_process"} ${state.coldStart.preProcessMs}`,
        `embedding_cold_start_ms{${labels},phase="runtime_init"} ${state.coldStart.runtimeInitMs ?? 0}`,
        `embedding_cold_start_ms{${labels},phase="discover"} ${state.coldStart.discoverMs ?? 0}`,
        `embedding_cold_start_ms{${labels},phase="load"} ${state.coldStart.loadMs ?? 0}`,
        // This is the histogram KEDA scales on. CPU is the wrong signal for an
        // inference pod: it saturates long after latency has degraded, and it
        // barely moves when the bottleneck is memory bandwidth.
        '# HELP embedding_query_latency_ms Query latency.',
        '# TYPE embedding_query_latency_ms histogram',
    ];
    for (const [boundary, count] of Object.entries(state.metrics.latencyBuckets)) {
        lines.push(`embedding_query_latency_ms_bucket{${labels},le="${boundary}"} ${count}`);
    }
    lines.push(
        `embedding_query_latency_ms_bucket{${labels},le="+Inf"} ${state.metrics.queries}`,
        `embedding_query_latency_ms_sum{${labels}} ${state.metrics.latencySumMs.toFixed(3)}`,
        `embedding_query_latency_ms_count{${labels}} ${state.metrics.queries}`,
    );
    res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
});

const server = app.listen(PORT, () => {
    log(`listening on ${PORT} · shard=${SHARD_ID} · artifacts=${backend.kind}`);
    consensus.startWatch('model/', onModelEvent);
    void bootstrap();
});

function shutdown(signal) {
    log(`${signal} · draining`);
    // Releasing the readiness ack lets a controller tell "pod is gone" from
    // "pod has not finished preloading", which otherwise look identical and
    // would stall a rollout on a pod that no longer exists.
    consensus.del(`model/ready/${POD_ID}`)
        .catch(() => {})
        .finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, state };
