#!/usr/bin/env node
/**
 * coldstart-bench.js — cold start, broken down by phase.
 *
 * The single number is the least useful thing here. "Cold start is fourteen
 * seconds" tells nobody what to do. "Twelve of those fourteen are weight load,
 * one is checksum, and process start is noise" says: bake the weights into the
 * image, and stop optimising anything else.
 *
 * So this measures each phase separately, repeats to get a distribution rather
 * than one lucky sample, and then measures the same thing again under each
 * mitigation so the improvement is demonstrated rather than claimed.
 *
 * Phases, outermost first:
 *
 *   pre-process   image pull and sandbox setup. Invisible from inside the
 *                 container, so the harness stamps BOOT_T0 before spawning and
 *                 the pod reports the delta. On Fargate this is usually the
 *                 largest phase and the one a smaller image actually fixes.
 *   runtime init  node boot plus module load.
 *   discover      two reads against the Raft cluster to learn the manifest.
 *   fetch         pulling weights and shard from object storage.
 *   verify        checksumming what was fetched.
 *   parse         materialising typed arrays.
 *
 *   node tools/coldstart-bench.js --runs 7
 */

const { spawn } = require('child_process');
const path = require('path');

const REPO = path.join(__dirname, '..');
const REPLICAS = process.env.RAFT_REPLICAS_URLS
    || 'http://127.0.0.1:5001,http://127.0.0.1:5002,http://127.0.0.1:5003';
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.join(REPO, 'artifacts');
const PORT = Number(process.env.BENCH_PORT || 7500);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs() {
    const options = { runs: 7, warmup: 1 };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        if (key in options) options[key] = Number(argv[i + 1]);
    }
    return options;
}

/**
 * Boots one pod, waits for it to become ready, records the breakdown, kills it.
 * `extraDelayMs` simulates a slower artifact source — the difference between
 * weights baked into the image and weights pulled across a network.
 */
async function coldBoot({ label, env = {} }) {
    const bootT0 = Date.now();
    const child = spawn('node', [path.join(REPO, 'serving', 'index.js')], {
        env: {
            ...process.env,
            POD_ID: `bench-${label}-${Date.now()}`,
            PORT: String(PORT),
            SHARD_ID: '0',
            ARTIFACT_DIR,
            RAFT_REPLICAS_URLS: REPLICAS,
            BOOT_T0: String(bootT0),
            ...env,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    try {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            await sleep(10);
            try {
                const ready = await fetch(`http://127.0.0.1:${PORT}/readyz`);
                if (ready.status !== 200) continue;

                // Issue one query so first-query cost — JIT warmup, first
                // touch of the weight pages — lands in the measurement rather
                // than being quietly excluded.
                await fetch(`http://127.0.0.1:${PORT}/search`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ query: 'a photo of a dog', topK: 3 }),
                });

                const status = await (await fetch(`http://127.0.0.1:${PORT}/status`)).json();
                return { ok: true, coldStart: status.coldStart };
            } catch (_) { /* not up yet */ }
        }
        return { ok: false, error: `never became ready${stderr ? `: ${stderr.slice(0, 200)}` : ''}` };
    } finally {
        child.kill('SIGKILL');
        await sleep(150);
    }
}

const percentile = (values, p) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

function summarise(label, samples) {
    const pick = (fn) => samples.map(fn).filter((v) => Number.isFinite(v));

    const rows = [
        ['pre-process', pick((s) => s.preProcessMs)],
        ['runtime init', pick((s) => s.runtimeInitMs)],
        ['discover', pick((s) => s.discoverMs)],
        ['fetch weights', pick((s) => s.phases?.fetchWeights)],
        ['fetch shard', pick((s) => s.phases?.fetchShard)],
        ['verify', pick((s) => s.phases?.verify)],
        ['parse', pick((s) => s.phases?.parse)],
    ];

    // The denominator has to span every phase in the table, or the shares do
    // not add up. `totalToActiveMs` runs from BOOT_T0 to activation and is the
    // right choice here because the bench publishes the manifest before booting
    // anything — so no sample includes idle time waiting for one to appear.
    const totals = pick((s) => s.totalToActiveMs);
    const postManifest = pick((s) => s.activeAfterManifestMs);
    const firstQueryAt = pick((s) => s.firstQueryAtMs);
    const firstQuery = pick((s) => s.firstQueryMs);

    console.log(`\n${label}  (n=${samples.length})`);
    console.log('  phase            mean      p50      p95     share');
    let accounted = 0;
    for (const [name, values] of rows) {
        const m = mean(values);
        accounted += m;
        const share = mean(totals) > 0 ? (m / mean(totals)) * 100 : 0;
        console.log(
            `  ${name.padEnd(15)}${m.toFixed(1).padStart(7)}ms` +
            `${percentile(values, 50).toFixed(1).padStart(8)}ms` +
            `${percentile(values, 95).toFixed(1).padStart(8)}ms` +
            `${share.toFixed(0).padStart(8)}%`,
        );
    }
    // Scheduling gaps, watch delivery and event-loop turns between phases. If
    // this grows large the breakdown is missing something and should be
    // instrumented rather than hand-waved.
    const unaccounted = mean(totals) - accounted;
    console.log(`  ${'unaccounted'.padEnd(15)}${unaccounted.toFixed(1).padStart(7)}ms` +
        `${''.padStart(8)}${''.padStart(8)}${(mean(totals) > 0 ? (unaccounted / mean(totals)) * 100 : 0).toFixed(0).padStart(8)}%`);
    console.log(`  ${'TOTAL boot→active'.padEnd(15)}${mean(totals).toFixed(1).padStart(6)}ms` +
        `${percentile(totals, 50).toFixed(1).padStart(8)}ms${percentile(totals, 95).toFixed(1).padStart(8)}ms`);
    console.log(`  ${'  of which post-manifest'}: ${mean(postManifest).toFixed(1)}ms`);
    console.log(`  ${'first query at'.padEnd(15)}${mean(firstQueryAt).toFixed(1).padStart(7)}ms` +
        `  (query itself took ${mean(firstQuery).toFixed(2)}ms)`);

    return { label, meanTotal: mean(totals), p95Total: percentile(totals, 95), rows };
}

(async () => {
    const options = parseArgs();
    console.log(`cold-start bench · ${options.runs} runs (+${options.warmup} discarded warmup)\n`);
    console.log('Requires a running Raft cluster with model/current already published:');
    console.log(`  replicas: ${REPLICAS}`);

    const scenarios = [
        {
            label: 'baseline — artifacts fetched, checksum verified',
            env: {},
        },
        {
            label: 'checksum skipped (measures what verification costs)',
            env: { SKIP_VERIFY: '1' },
        },
    ];

    const results = [];
    for (const scenario of scenarios) {
        const samples = [];
        for (let run = 0; run < options.runs + options.warmup; run += 1) {
            const result = await coldBoot(scenario);
            if (!result.ok) {
                console.error(`  run failed: ${result.error}`);
                continue;
            }
            // The first boot pays page-cache misses the rest do not. Keeping it
            // would report a bimodal distribution as a wide one.
            if (run >= options.warmup) samples.push(result.coldStart);
        }
        if (samples.length > 0) results.push(summarise(scenario.label, samples));
    }

    if (results.length >= 2) {
        const [baseline, ...rest] = results;
        console.log('\n--- what each mitigation buys ---');
        for (const result of rest) {
            const delta = baseline.meanTotal - result.meanTotal;
            const pct = baseline.meanTotal > 0 ? (delta / baseline.meanTotal) * 100 : 0;
            console.log(`  ${result.label}`);
            console.log(`    ${delta >= 0 ? '-' : '+'}${Math.abs(delta).toFixed(1)}ms ` +
                `(${pct >= 0 ? '' : '+'}${(-pct).toFixed(0)}% of baseline)`);
        }
    }

    console.log(`
--- reading these numbers ---
The artifact here is ~7MB of synthetic weights, so fetch and parse are small
and the total is dominated by fixed costs. A real CLIP checkpoint is roughly
two orders of magnitude larger and inverts that: fetch and parse become the
total, and everything measured above becomes rounding error.

That inversion is the point of measuring by phase rather than in aggregate.
The mitigations worth pursuing follow directly from which phase dominates:

  pre-process dominates   -> smaller image; drop build tooling from the runtime
                             layer; on Fargate this is the phase a multi-stage
                             build actually moves.
  fetch dominates         -> bake weights into the image and pay once at build,
                             or keep a warm pool floor so the fetch is amortised
                             across many requests instead of one.
  parse dominates         -> a memory-mappable format instead of one that has to
                             be materialised into typed arrays on every boot.

A warm pool floor is the blunt instrument that hides all of them, and it is the
one that shows up on the bill — which is exactly the tradeoff the cost curve in
tools/cost-model.js is there to make legible.`);
})().catch((error) => {
    console.error('bench failed:', error);
    process.exit(1);
});
