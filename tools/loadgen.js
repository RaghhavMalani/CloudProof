#!/usr/bin/env node
/**
 * loadgen.js — drives enough traffic to make the autoscaler do something.
 *
 * A scaling demo needs load that rises, holds, and falls, because the
 * interesting behaviour is asymmetric: KEDA is configured to add pods quickly
 * and remove them slowly, and you only see that if the load actually comes back
 * down. A flat load test would show a step up and nothing else.
 *
 * Reports observed p99 alongside the target so the scaler's effect is visible
 * from the client side rather than only in Grafana.
 *
 *   node tools/loadgen.js --targets http://localhost:8080 --peak 300 --hold 90
 */

const DEFAULTS = {
    targets: 'http://127.0.0.1:7000,http://127.0.0.1:7001,http://127.0.0.1:7002',
    start: 10,      // QPS at the beginning
    peak: 200,      // QPS at the plateau
    ramp: 30,       // seconds spent climbing
    hold: 60,       // seconds at peak
    down: 30,       // seconds spent falling
    report: 5,      // seconds between lines
};

function parseArgs() {
    const options = { ...DEFAULTS };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        if (!(key in options)) continue;
        options[key] = key === 'targets' ? argv[i + 1] : Number(argv[i + 1]);
    }
    options.targets = String(options.targets).split(',').filter(Boolean);
    return options;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const percentile = (values, p) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

(async () => {
    const options = parseArgs();
    const total = options.ramp + options.hold + options.down;
    console.log(`load: ${options.start} → ${options.peak} → ${options.start} QPS over ${total}s ` +
        `across ${options.targets.length} target(s)\n`);
    console.log('  t     QPS    sent   errors   p50     p99    versions');

    const startedAt = Date.now();
    let sent = 0;
    let errors = 0;
    let window = [];
    const versions = new Set();
    let cursor = 0;

    /** Target QPS at a given elapsed time — trapezoid. */
    function targetQps(elapsed) {
        if (elapsed < options.ramp) {
            return options.start + (options.peak - options.start) * (elapsed / options.ramp);
        }
        if (elapsed < options.ramp + options.hold) return options.peak;
        const falling = (elapsed - options.ramp - options.hold) / options.down;
        return Math.max(options.start, options.peak - (options.peak - options.start) * falling);
    }

    const reporter = setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000;
        console.log(
            `${elapsed.toFixed(0).padStart(4)}s ${targetQps(elapsed).toFixed(0).padStart(6)} ` +
            `${String(sent).padStart(7)} ${String(errors).padStart(8)} ` +
            `${percentile(window, 50).toFixed(1).padStart(6)}ms ${percentile(window, 99).toFixed(1).padStart(6)}ms  ` +
            `${[...versions].join(',') || '–'}`,
        );
        // Reset each window so p99 tracks current behaviour rather than
        // being permanently dragged up by the first cold request.
        window = [];
        versions.clear();
    }, options.report * 1000);

    while ((Date.now() - startedAt) / 1000 < total) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const qps = targetQps(elapsed);
        const batch = Math.max(1, Math.round(qps / 20)); // 20 batches per second

        await Promise.all(Array.from({ length: batch }, async () => {
            const target = options.targets[cursor++ % options.targets.length];
            const at = performance.now();
            try {
                const response = await fetch(`${target}/search`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ query: `a photo of a cat ${cursor}`, topK: 5 }),
                    signal: AbortSignal.timeout(5000),
                });
                if (!response.ok) { errors += 1; return; }
                const body = await response.json();
                versions.add(body.modelVersion);
                window.push(performance.now() - at);
                sent += 1;
            } catch (_) {
                errors += 1;
            }
        }));

        await sleep(50);
    }

    clearInterval(reporter);
    console.log(`\ndone — ${sent} requests, ${errors} errors`);
    console.log(`
While that ran, worth watching:
  kubectl -n cloudproof-serving get statefulset embedding -w
  kubectl -n cloudproof-serving get hpa
  Grafana → "Serving pods and throughput"

Expect pods to climb one at a time during the ramp, then stay up for a while
after load drops. The asymmetry is deliberate: cold start is expensive, so KEDA
is configured to add capacity quickly and give it back slowly.`);
})().catch((error) => {
    console.error(`loadgen failed: ${error.message}`);
    process.exit(1);
});
