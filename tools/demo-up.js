#!/usr/bin/env node
/**
 * demo-up.js — the whole system, one command.
 *
 *   node tools/demo-up.js
 *   → http://localhost:8080
 *
 * Boots three Raft replicas, three embedding pods and the dashboard, building
 * the v1 and v2 artifacts first if they are missing and publishing v1 so the
 * pods have something to serve. Everything is a child process of this one, so
 * Ctrl-C takes the whole thing down and leaves nothing orphaned.
 *
 * State lives under .demo-data/ and is *not* cleared between runs — restart it
 * and the cluster recovers its log, which is the point of the persistence work
 * and worth seeing rather than reading about. Pass --fresh to wipe it.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const DATA_DIR = path.join(REPO, '.demo-data');
const ARTIFACT_DIR = path.join(REPO, 'artifacts');
const RAFT_PORTS = [5001, 5002, 5003];
const POD_PORTS = [7000, 7001, 7002];
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 8080);
const FRESH = process.argv.includes('--fresh');
const VERBOSE = process.argv.includes('--verbose');

const REPLICA_URLS = RAFT_PORTS.map((p) => `http://127.0.0.1:${p}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function start(label, args, env, colour) {
    const child = spawn('node', args, {
        cwd: REPO,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const write = (stream, data) => {
        if (!VERBOSE) return;
        for (const line of data.toString().split('\n')) {
            if (line.trim()) stream.write(`\x1b[${colour}m${label.padEnd(10)}\x1b[0m ${line}\n`);
        }
    };
    child.stdout.on('data', (d) => write(process.stdout, d));
    child.stderr.on('data', (d) => write(process.stderr, d));
    child.on('exit', (code) => {
        if (code !== 0 && code !== null) console.error(`\x1b[31m${label} exited with ${code}\x1b[0m`);
    });
    children.push(child);
    return child;
}

function shutdown() {
    for (const child of children) child.kill('SIGTERM');
    setTimeout(() => {
        for (const child of children) child.kill('SIGKILL');
        process.exit(0);
    }, 800).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function waitFor(url, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(500) });
            if (response.ok) return true;
        } catch (_) { /* not up yet */ }
        await sleep(150);
    }
    return false;
}

(async () => {
    if (FRESH) fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Artifacts are deterministic from their version string, so rebuilding is
    // idempotent — but it takes a moment, so skip it when they already exist.
    for (const version of ['v1', 'v2']) {
        if (fs.existsSync(path.join(ARTIFACT_DIR, 'index', version, 'manifest.json'))) continue;
        console.log(`building ${version} artifacts…`);
        await new Promise((resolve, reject) => {
            const build = spawn('node', [
                path.join(REPO, 'tools', 'make-artifact.js'),
                '--version', version, '--out', ARTIFACT_DIR,
            ], { stdio: 'ignore' });
            build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build ${version} failed`))));
        });
    }

    console.log('starting consensus tier…');
    RAFT_PORTS.forEach((port, i) => {
        start(`replica${i + 1}`, [path.join(REPO, 'replica', 'index.js')], {
            DATA_DIR,
            REPLICA_ID: `replica${i + 1}`,
            PORT: String(port),
            PEERS: RAFT_PORTS.filter((p) => p !== port).map((p) => `http://127.0.0.1:${p}`).join(','),
            NODE_URL: `http://127.0.0.1:${port}`,
            // No gateway in this demo; point it somewhere closed so the commit
            // hook fails fast instead of hanging on a connect timeout.
            GATEWAY_URL: 'http://127.0.0.1:1',
        }, 36 + i);
    });

    for (const url of REPLICA_URLS) {
        if (!await waitFor(`${url}/health`)) throw new Error(`${url} never came up`);
    }

    // A leader must exist before anything can be written.
    const deadline = Date.now() + 10000;
    let leader = null;
    while (Date.now() < deadline && !leader) {
        for (const url of REPLICA_URLS) {
            const status = await fetch(`${url}/status`).then((r) => r.json()).catch(() => null);
            if (status?.state === 'LEADER') leader = url;
        }
        if (!leader) await sleep(150);
    }
    if (!leader) throw new Error('no leader was elected');
    console.log(`leader elected: ${leader}`);

    console.log('starting serving tier…');
    POD_PORTS.forEach((port, i) => {
        start(`pod-${i}`, [path.join(REPO, 'serving', 'index.js')], {
            POD_ID: `pod-${i}`,
            PORT: String(port),
            SHARD_ID: String(i),
            ARTIFACT_DIR,
            RAFT_REPLICAS_URLS: REPLICA_URLS.join(','),
        }, 33 + i);
    });
    for (const port of POD_PORTS) await waitFor(`http://127.0.0.1:${port}/healthz`);

    // Publish v1 unless a previous run already left a version active — on a
    // warm restart the pods recover it from the log themselves, which is the
    // behaviour worth demonstrating.
    const { ConsensusClient } = require(path.join(REPO, 'serving', 'consensus-client'));
    const { RolloutController } = require(path.join(REPO, 'serving', 'rollout-controller'));
    const consensus = new ConsensusClient(REPLICA_URLS, { label: 'demo-up' });

    const current = await consensus.get('model/current', { linearizable: true }).catch(() => null);
    if (current) {
        console.log(`model/current already set to ${current.value.version} — recovered from the log`);
    } else {
        const manifest = require(path.join(ARTIFACT_DIR, 'index', 'v1', 'manifest.json'));
        const controller = new RolloutController(consensus, { holder: 'demo-up', log: () => {} });
        await controller.acquireLock();
        const result = await controller.rollout(manifest, { expectedPods: POD_PORTS.length });
        await controller.releaseLock();
        console.log(result.ok
            ? `published v1 (preload ${result.preloadMs}ms, flip ${result.flipMs}ms)`
            : `v1 rollout stalled: ${result.error}`);
    }

    start('dashboard', [path.join(REPO, 'tools', 'dashboard.js')], {
        DASHBOARD_PORT: String(DASHBOARD_PORT),
        RAFT_REPLICAS_URLS: REPLICA_URLS.join(','),
        SERVING_URLS: POD_PORTS.map((p) => `http://127.0.0.1:${p}`).join(','),
        ARTIFACT_DIR,
    }, 35);
    await waitFor(`http://127.0.0.1:${DASHBOARD_PORT}/api/state`);

    // --tunnel publishes the dashboard on a temporary public URL through
    // Cloudflare's quick tunnel: no account, no cost, and it dies with this
    // process. Good for showing someone during a call; deliberately not a
    // hosting story, since anyone with the link can press "Pause the leader".
    if (process.argv.includes('--tunnel')) {
        console.log('opening a public tunnel…');
        const tunnel = spawn('cloudflared', [
            'tunnel', '--url', `http://localhost:${DASHBOARD_PORT}`, '--no-autoupdate',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        tunnel.on('error', () => {
            console.log('  cloudflared not found — install it, or skip --tunnel and use localhost');
        });

        const findUrl = (data) => {
            const match = data.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
            if (match) {
                console.log(`\n  public URL → ${match[0]}\n  (temporary, dies when you stop this process)\n`);
            }
        };
        tunnel.stdout.on('data', findUrl);
        tunnel.stderr.on('data', findUrl); // cloudflared prints the URL to stderr
        children.push(tunnel);
    }

    console.log(`
  ┌──────────────────────────────────────────────────────┐
  │  CloudProof is running                               │
  │                                                      │
  │    dashboard   http://localhost:${String(DASHBOARD_PORT).padEnd(21)}│
  │    replicas    :5001  :5002  :5003                   │
  │    pods        :7000  :7001  :7002                   │
  │                                                      │
  │  Try, in the dashboard:                              │
  │    1. "Query every shard"  — note the version tag    │
  │    2. "Roll out v2"        — watch all three flip     │
  │    3. "Pause the leader"   — watch a new one elected │
  │    4. Ctrl-C, rerun        — state recovers from disk│
  │                                                      │
  │  Ctrl-C to stop.  --fresh wipes state.  --verbose    │
  │  streams every process's logs.                       │
  └──────────────────────────────────────────────────────┘
`);
})().catch((error) => {
    console.error(`\ndemo failed to start: ${error.message}`);
    shutdown();
    process.exitCode = 1;
});
