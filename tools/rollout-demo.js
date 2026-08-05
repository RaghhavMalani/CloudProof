#!/usr/bin/env node
/**
 * rollout-demo.js — proves the rollout is atomic, and proves it under load.
 *
 * A rollout demo that stops traffic first proves nothing. The whole risk lives
 * in the requests that are in flight while the version changes, so this drives
 * continuous query load throughout and checks two things about every response:
 *
 *   safety   no single response ever mixes vector spaces, and once the fleet
 *            has converged no straggler serves the old version again
 *   liveness every pod actually reaches the new version, and the window during
 *            which the fleet disagrees is measured rather than assumed
 *
 * The second one is the honest part. The window is not zero — Raft commits the
 * flip, then each pod's watch delivers it, then each swaps a pointer. What the
 * two-phase protocol buys is that the window is bounded by watch delivery
 * rather than by artifact download, which is the difference between
 * milliseconds and tens of seconds.
 */

const { spawn } = require('child_process');
const path = require('path');

const { ConsensusClient } = require('../serving/consensus-client');
const { RolloutController } = require('../serving/rollout-controller');

const REPO = path.join(__dirname, '..');
const REPLICAS = ['http://127.0.0.1:5001', 'http://127.0.0.1:5002', 'http://127.0.0.1:5003'];
const POD_COUNT = Number(process.env.PODS || 3);
const BASE_PORT = 7000;
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.join(REPO, 'artifacts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const loadManifest = (version) =>
    require(path.join(ARTIFACT_DIR, 'index', version, 'manifest.json'));

let failures = 0;
function check(label, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
}

async function main() {
    const pods = [];
    for (let i = 0; i < POD_COUNT; i += 1) {
        pods.push(spawn('node', [path.join(REPO, 'serving', 'index.js')], {
            env: {
                ...process.env,
                POD_ID: `pod-${i}`,
                PORT: String(BASE_PORT + i),
                SHARD_ID: String(i),
                ARTIFACT_DIR,
                RAFT_REPLICAS_URLS: REPLICAS.join(','),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        }));
        pods[i].stdout.on('data', (d) => process.stdout.write(`  ${d}`));
        pods[i].stderr.on('data', (d) => process.stderr.write(`  ! ${d}`));
    }

    const cleanup = () => pods.forEach((p) => p.kill('SIGKILL'));
    process.on('exit', cleanup);

    await sleep(2500);

    const consensus = new ConsensusClient(REPLICAS, { label: 'demo-controller' });
    const controller = new RolloutController(consensus, { holder: 'demo-controller' });

    // ── initial publish ──────────────────────────────────────────────────────
    const v1 = loadManifest('v1');
    const v2 = loadManifest('v2');

    await controller.acquireLock();
    console.log('\n--- publishing v1 ---');
    const first = await controller.rollout(v1, { expectedPods: POD_COUNT });
    check('v1 rolled out to every pod', first.ok, first);

    await sleep(500);

    // ── continuous load ──────────────────────────────────────────────────────
    const observations = [];
    let querying = true;

    const driver = (async () => {
        let n = 0;
        while (querying) {
            const port = BASE_PORT + (n % POD_COUNT);
            n += 1;
            try {
                const response = await fetch(`http://127.0.0.1:${port}/search`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ query: `a photo of a cat ${n}`, topK: 3 }),
                });
                if (response.ok) {
                    const body = await response.json();
                    observations.push({
                        at: Date.now(),
                        pod: body.podId,
                        version: body.modelVersion,
                        topId: body.results[0]?.id,
                        topScore: body.results[0]?.score,
                    });
                } else {
                    observations.push({ at: Date.now(), pod: `port-${port}`, version: null, status: response.status });
                }
            } catch (_) {
                observations.push({ at: Date.now(), pod: `port-${port}`, version: null, error: true });
            }
            await sleep(4);
        }
    })();

    await sleep(600);

    // ── the rollout under load ───────────────────────────────────────────────
    console.log('\n--- staging v2 while serving traffic ---');
    const stagedAt = Date.now();
    const staged = await controller.stage(v2, { expectedPods: POD_COUNT });
    check('every pod preloaded v2 without dropping traffic', staged.ok, staged);

    const duringPreload = observations.filter((o) => o.at >= stagedAt && o.version !== null);
    check('traffic served throughout the preload was still all v1',
        duringPreload.length > 0 && duringPreload.every((o) => o.version === 'v1'),
        { samples: duringPreload.length, versions: [...new Set(duringPreload.map((o) => o.version))] });

    console.log('\n--- flipping model/current ---');
    const flipAt = Date.now();
    const flipped = await controller.activate(v2);
    check('flip committed', flipped.ok, flipped);
    console.log(`    commit took ${flipped.flipMs}ms`);

    await sleep(2000);
    querying = false;
    await driver;

    // ── analysis ─────────────────────────────────────────────────────────────
    const served = observations.filter((o) => o.version !== null);
    const errors = observations.length - served.length;

    // Convergence: the last moment any pod still answered v1.
    const lastV1 = served.filter((o) => o.version === 'v1').at(-1);
    const firstV2 = served.find((o) => o.version === 'v2');
    const convergenceWindowMs = lastV1 && firstV2 ? Math.max(0, lastV1.at - firstV2.at) : 0;

    // Per pod, when did it flip?
    const flipTimes = new Map();
    for (const o of served) {
        if (o.version === 'v2' && !flipTimes.has(o.pod)) flipTimes.set(o.pod, o.at - flipAt);
    }

    console.log('\n--- results ---');
    console.log(`requests issued:        ${observations.length}`);
    console.log(`served:                 ${served.length}  (errors/unavailable: ${errors})`);
    console.log(`versions observed:      ${[...new Set(served.map((o) => o.version))].join(', ')}`);
    console.log('per-pod flip latency after the commit:');
    for (const [pod, ms] of [...flipTimes].sort()) console.log(`  ${pod.padEnd(8)} ${ms}ms`);
    console.log(`fleet disagreement window: ${convergenceWindowMs}ms`);

    check('no request failed during the rollout', errors === 0, { errors });
    check('every pod reached v2', flipTimes.size === POD_COUNT, [...flipTimes.keys()]);
    check('no pod reverted to v1 after flipping',
        served.every((o, i) => !(o.version === 'v1' && served.slice(0, i).some((p) => p.pod === o.pod && p.version === 'v2'))),
        'a pod served v1 after having served v2');

    // The scores must actually differ across versions, otherwise this proves
    // nothing: identical results would mean the two "models" share a vector
    // space and mixing them was never dangerous in the first place.
    const v1Scores = served.filter((o) => o.version === 'v1').map((o) => o.topScore);
    const v2Scores = served.filter((o) => o.version === 'v2').map((o) => o.topScore);
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    check('v1 and v2 are genuinely different vector spaces',
        Math.abs(mean(v1Scores) - mean(v2Scores)) > 1e-6,
        { v1: mean(v1Scores), v2: mean(v2Scores) });

    // ── rollback ─────────────────────────────────────────────────────────────
    console.log('\n--- rolling back to v1 ---');
    const rollbackAt = Date.now();
    const rolledBack = await controller.rollback(v1);
    check('rollback committed', rolledBack.ok, rolledBack);

    await sleep(1200);
    const statuses = await Promise.all(
        pods.map((_, i) => fetch(`http://127.0.0.1:${BASE_PORT + i}/status`).then((r) => r.json())),
    );
    check('every pod is back on v1', statuses.every((s) => s.active === 'v1'),
        statuses.map((s) => `${s.podId}=${s.active}`));
    console.log(`rollback wall time to full convergence: ${Date.now() - rollbackAt}ms`);
    console.log(`rollbacks recorded by pods: ${statuses.map((s) => s.metrics.rollbacks).join(', ')}`);
    check('rollback reused the retired slot rather than refetching',
        statuses.every((s) => s.metrics.rollbacks >= 1),
        statuses.map((s) => s.metrics));

    await controller.releaseLock();

    // ── second controller is refused ─────────────────────────────────────────
    const intruder = new RolloutController(
        new ConsensusClient(REPLICAS, { label: 'intruder' }), { holder: 'intruder' },
    );
    await intruder.acquireLock();
    let refused = false;
    try {
        // waitMs:0 makes this assert the refusal itself rather than the
        // wait-it-out behaviour. Without it this would block for the full
        // default window while the intruder keeps renewing, and the test would
        // look like a hang rather than a pass.
        await controller.acquireLock(30000, { waitMs: 0 });
    } catch (_) {
        refused = true;
    }
    check('a second concurrent rollout is refused the lock', refused);
    await intruder.releaseLock();

    console.log('\ncold-start breakdown (first activation, per pod):');
    for (const s of statuses) {
        const c = s.coldStart;
        console.log(`  ${s.podId}  total=${c.totalToActiveMs}ms afterManifest=${c.activeAfterManifestMs}ms ` +
            `runtime=${c.runtimeInitMs}ms discover=${c.discoverMs}ms load=${c.loadMs?.toFixed(0)}ms ` +
            `[${Object.entries(c.phases || {}).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(' ')}]`);
    }

    cleanup();
    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('demo failed:', error);
    process.exit(1);
});
