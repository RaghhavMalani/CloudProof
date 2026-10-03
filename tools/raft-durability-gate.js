#!/usr/bin/env node
'use strict';

/**
 * raft-durability-gate.js — acknowledged-write durability under forced leader
 * death, on a live three-process cluster (Phase IV-A publication gate).
 *
 *   node tools/raft-durability-gate.js [--runs 5] [--out artifacts/perf/phase-iv-a/durability-gate]
 *
 * For each window, `runs` times, on a fresh cluster:
 *
 *   1. Closed-loop writer lanes issue unique logical writes (one key each)
 *      carrying clientId + seqNo. Even lanes retry an in-doubt attempt
 *      (timeout, reset, 503) with the *same* clientId/seqNo against whoever
 *      leads now (the exactly-once path), so retries are how duplicates would
 *      appear. Odd lanes never retry an in-doubt attempt: the write stays
 *      unacknowledged, and whether it was committed anyway is counted. Both
 *      kinds retry an attempt that provably never reached a leader (307,
 *      connection refused, no leader known).
 *   2. Under load, a test-only failpoint (replica/failpoints.js) is armed on
 *      the current leader. When its site is hit, the leader writes a marker
 *      with its Raft state and terminates on the spot.
 *   3. Load continues against the new leader; then the lanes stop, the dead
 *      node restarts from its own data directory, and the cluster converges.
 *   4. From every node: the committed log prefix and the local state machine.
 *
 * Counted per run, and required for the gate:
 *
 *   acknowledged            writes some attempt got a 2xx for
 *   recovered acknowledged  acknowledged writes in every node's committed log
 *                           exactly once and with the right value in every
 *                           node's state machine
 *   missing acknowledged    acknowledged - recovered          (gate: 0)
 *   duplicate logical       logical writes with more than one committed entry
 *                           on any node                       (gate: 0)
 *   unacknowledged recovered  attempted, never acknowledged, but committed
 *                           (allowed: the client cannot tell; e.g. a commit
 *                           whose reply died with the leader)
 *
 * Also checked: the committed prefixes of all nodes are identical, and the
 * failpoint marker shows the leader died inside the named window.
 *
 * Scope: a process kill loses what the process had not yet written; it does
 * not lose data the OS already holds. Losing written-but-unfsynced data needs
 * power loss, which the deterministic simulator's targeted campaign covers
 * (sim/perf-faults.js).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { LocalCluster, requestJson, sleep } = require('../packages/raft-bench/cluster');
const { parseArgs } = require('../packages/raft-bench/cli');
const { profileOptions } = require('../replica/raft-profiles');
const { Rng } = require('../sim/simulator');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const WINDOWS = [
    { id: 'before-group-flush', label: 'before group flush', site: 'leader.beforeFlush', profile: 'group-commit',
        inWindow: (c) => c.pendingEntries > 0 },
    { id: 'after-flush-before-quorum', label: 'after flush / before quorum', site: 'leader.durableBeforeQuorum', profile: 'group-commit',
        inWindow: (c) => c.durableLength - 1 > c.commitIndex },
    { id: 'after-commit-before-reply', label: 'after commit / before client reply', site: 'leader.committedBeforeReply', profile: 'optimized-http',
        inWindow: (c) => c.commitIndex >= 0 },
    { id: 'pipelined-replication', label: 'during pipelined replication', site: 'leader.pipelinedInflight', profile: 'group-pipeline',
        inWindow: (c) => c.stillInflight > 0 },
    { id: 'batched-replication', label: 'during batched replication', site: 'leader.batchedReplication', profile: 'group-batch',
        inWindow: (c) => c.carried > 1 },
    { id: 'binary-transport', label: 'binary transport active', site: 'transport.framedInflight', profile: 'optimized-binary',
        inWindow: (c) => c.outstanding > 1 && c.entries > 0 },
];

const DEFAULTS = {
    runs: 5,
    lanes: 24,
    payload: 1024,
    'warmup-ms': 1500,
    'post-kill-ms': 3000,
    'attempt-timeout-ms': 2500,
    'give-up-ms': 20000,
    windows: null,
    seed: 4207,
    port: 18001,
    out: path.join(ROOT, 'artifacts', 'perf', 'phase-iv-a', 'durability-gate'),
    'data-dir': path.join(ROOT, '.bench-data', 'durability'),
};

const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

function put(url, body, timeoutMs) {
    return new Promise((resolve) => {
        const target = new URL(url);
        const payload = Buffer.from(JSON.stringify(body));
        const req = http.request({
            host: target.hostname, port: target.port, path: target.pathname, method: 'PUT', agent,
            headers: { 'content-type': 'application/json', 'content-length': payload.length },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let data = null;
                try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* non-JSON */ }
                resolve({ status: res.statusCode, data });
            });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('ETIMEDOUT')));
        req.on('error', (error) => resolve({ status: 0, error: error.message }));
        req.end(payload);
    });
}

async function currentLeader(cluster, alive) {
    const statuses = await cluster.statuses();
    const leaders = statuses.filter((s, i) => alive[i] && s.state === 'LEADER');
    return leaders.length === 1 ? leaders[0].url : null;
}

/** One closed-loop lane of unique logical writes with same-id retries. */
async function lane({ index, runTag, cluster, alive, state, options }) {
    const retriesInDoubt = index % 2 === 0;
    const clientId = `${runTag}-lane${index}`;
    const pad = 'x'.repeat(Math.max(0, options.payload - 40));
    let seqNo = 0;
    while (!state.stop) {
        seqNo += 1;
        const key = `d/${clientId}/${seqNo}`;
        const value = `${clientId}:${seqNo}:${pad}`;
        const id = `${clientId}:${seqNo}`;
        const record = { id, key, clientId, seqNo, attempts: 0, acked: false, retriesInDoubt, inDoubt: false };
        state.writes.set(id, record);
        const giveUpAt = Date.now() + options['give-up-ms'];
        while (!record.acked && Date.now() < giveUpAt) {
            const target = state.leaderUrl || await currentLeader(cluster, alive);
            if (!target) { await sleep(50); continue; }
            record.attempts += 1;
            const response = await put(`${target}/kv/${encodeURIComponent(key)}`, { value, clientId, seqNo }, options['attempt-timeout-ms']);
            if (response.status >= 200 && response.status < 300) {
                record.acked = true;
                record.ackedAt = Date.now();
                record.ackedBy = target;
                state.acks += 1;
                break;
            }
            if (response.status === 307) {
                // Rejected before anything was appended: always safe to resend.
                state.leaderUrl = response.data && response.data.leaderUrl ? response.data.leaderUrl : null;
                continue;
            }
            if (state.leaderUrl === target) state.leaderUrl = null;
            if (response.status === 0 && /ECONNREFUSED/.test(response.error || '')) { await sleep(20); continue; }
            // Timeout, reset or 503: the write may or may not have been appended.
            record.inDoubt = true;
            if (!retriesInDoubt) break;
            await sleep(20);
        }
        if (!record.acked && retriesInDoubt) record.gaveUp = true;
    }
}

async function waitForConvergence(cluster, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    let previous = null;
    while (Date.now() < deadline) {
        const statuses = await cluster.statuses();
        const ok = statuses.every((s) => !s.error);
        const leaders = statuses.filter((s) => s.state === 'LEADER');
        if (ok && leaders.length === 1) {
            const commits = statuses.map((s) => s.commitIndex);
            const settled = commits.every((c) => c === commits[0])
                && statuses.every((s) => s.lastApplied === s.commitIndex && s.logLength === s.commitIndex + 1);
            const signature = JSON.stringify(statuses.map((s) => [s.term, s.commitIndex, s.lastApplied]));
            if (settled && signature === previous) return statuses;
            previous = settled ? signature : null;
        }
        await sleep(300);
    }
    throw new Error('cluster did not converge');
}

const entryId = (entry) => (entry.data && entry.data.clientId ? `${entry.data.clientId}:${entry.data.seqNo}` : null);
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function runOnce({ window, run, options, rng }) {
    const runTag = `${window.id}-r${run}`;
    const dataRoot = path.join(options['data-dir'], runTag);
    const env = { RAFT_PROFILE: window.profile, RAFT_TEST_FAILPOINTS: '1' };
    const cluster = new LocalCluster({ basePort: options.port, dataRoot, env, label: runTag });
    const alive = [true, true, true];
    const state = { stop: false, writes: new Map(), acks: 0, leaderUrl: null };
    const result = { window: window.id, label: window.label, site: window.site, profile: window.profile, run };
    try {
        const leader = await cluster.start();
        state.leaderUrl = leader.url;
        const lanes = Array.from({ length: options.lanes }, (_, index) => lane({ index, runTag, cluster, alive, state, options }));
        await sleep(options['warmup-ms']);

        const leaderUrl = await currentLeader(cluster, alive);
        const victim = cluster.urls.indexOf(leaderUrl);
        const skip = rng.range(0, 40);
        const armed = await requestJson(`${leaderUrl}/test/failpoint`, { method: 'POST', body: { name: window.site, skip } });
        if (armed.status !== 200) throw new Error(`arming failed: ${JSON.stringify(armed.data)}`);
        result.victim = `replica${victim + 1}`;
        result.skip = skip;
        result.ackedBeforeArm = state.acks;
        const armedAt = Date.now();

        const exited = await Promise.race([cluster.exits[victim], sleep(15000).then(() => null)]);
        if (!exited) throw new Error(`failpoint ${window.site} did not fire within 15 s`);
        alive[victim] = false;
        if (state.leaderUrl === leaderUrl) state.leaderUrl = null;
        result.killedAfterMs = Date.now() - armedAt;
        result.exit = exited;
        const markerFile = path.join(dataRoot, `replica${victim + 1}`, `failpoint-replica${victim + 1}.json`);
        const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8').replace(/^FAILPOINT /, ''));
        result.marker = marker;
        result.inWindow = marker.name === window.site && window.inWindow(marker.context);
        result.ackedAtKill = state.acks;

        await sleep(options['post-kill-ms']);
        result.newLeader = await currentLeader(cluster, alive);
        state.stop = true;
        await Promise.all(lanes);

        await cluster.restart(victim);
        alive[victim] = true;
        await cluster.waitForHealth();
        const statuses = await waitForConvergence(cluster);
        result.final = statuses.map((s) => ({ replica: s.replicaId, state: s.state, term: s.term, commitIndex: s.commitIndex }));

        const logs = await Promise.all(cluster.urls.map(async (url) => (await requestJson(`${url}/log`, { timeoutMs: 60000 })).data));
        const kvs = await Promise.all(cluster.urls.map(async (url) => (await requestJson(`${url}/kv?prefix=d/&stale=1`, { timeoutMs: 60000 })).data));
        const committed = logs.map((l) => l.log.slice(0, l.commitIndex + 1));
        result.committedPrefixesIdentical = committed.every((c) => digest(c) === digest(committed[0]));

        const writes = [...state.writes.values()];
        const acked = writes.filter((w) => w.acked);
        const counts = committed.map((entries) => {
            const map = new Map();
            for (const entry of entries) {
                const id = entryId(entry);
                if (id) map.set(id, (map.get(id) || 0) + 1);
            }
            return map;
        });
        const values = kvs.map((kv) => new Map(kv.keys.map((k) => [k.key, k.value])));
        const expectedValue = (w) => `${w.clientId}:${w.seqNo}:${'x'.repeat(Math.max(0, options.payload - 40))}`;
        const recovered = acked.filter((w) => counts.every((m) => m.get(w.id) === 1)
            && values.every((m) => m.get(w.key) === expectedValue(w)));
        const duplicateIds = new Set();
        for (const map of counts) for (const [id, n] of map) if (n > 1) duplicateIds.add(id);
        const unacked = writes.filter((w) => !w.acked);
        result.counts = {
            attempted: writes.length,
            acknowledged: acked.length,
            recoveredAcknowledged: recovered.length,
            missingAcknowledged: acked.length - recovered.length,
            duplicateLogicalWrites: duplicateIds.size,
            unacknowledged: unacked.length,
            unacknowledgedRecovered: unacked.filter((w) => counts[0].get(w.id) >= 1).length,
            inDoubtRetriedAndAcknowledged: writes.filter((w) => w.retriesInDoubt && w.inDoubt && w.acked).length,
            retriedWrites: writes.filter((w) => w.attempts > 1).length,
            gaveUp: writes.filter((w) => w.gaveUp).length,
            committedEntries: committed[0].length,
        };
        result.missingIds = acked.filter((w) => !recovered.includes(w)).slice(0, 20).map((w) => w.id);
        result.duplicateIds = [...duplicateIds].slice(0, 20);
        result.pass = result.inWindow && result.committedPrefixesIdentical
            && result.counts.missingAcknowledged === 0 && result.counts.duplicateLogicalWrites === 0;
    } catch (error) {
        state.stop = true;
        result.error = error.message;
        result.pass = false;
    } finally {
        await cluster.stop({ keepData: !result.pass });
    }
    return result;
}

function gitState() {
    const git = (args) => execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = git('status --porcelain --untracked-files=no');
    return { sha: git('rev-parse HEAD'), dirty: dirty.length > 0, dirtyFiles: dirty ? dirty.split('\n') : [] };
}

function summarize(results) {
    const byWindow = WINDOWS.map((window) => {
        const runs = results.filter((r) => r.window === window.id);
        const sum = (field) => runs.reduce((total, r) => total + (r.counts ? r.counts[field] : 0), 0);
        return {
            window: window.id,
            label: window.label,
            site: window.site,
            profile: window.profile,
            runs: runs.length,
            killsInWindow: runs.filter((r) => r.inWindow).length,
            acknowledged: sum('acknowledged'),
            recoveredAcknowledged: sum('recoveredAcknowledged'),
            missingAcknowledged: sum('missingAcknowledged'),
            duplicateLogicalWrites: sum('duplicateLogicalWrites'),
            unacknowledged: sum('unacknowledged'),
            unacknowledgedRecovered: sum('unacknowledgedRecovered'),
            retriedWrites: sum('retriedWrites'),
            inDoubtRetriedAndAcknowledged: sum('inDoubtRetriedAndAcknowledged'),
            gaveUp: sum('gaveUp'),
            prefixesIdentical: runs.every((r) => r.committedPrefixesIdentical),
            errors: runs.filter((r) => r.error).map((r) => r.error),
            pass: runs.length > 0 && runs.every((r) => r.pass),
        };
    }).filter((w) => w.runs > 0);
    return { windows: byWindow, pass: byWindow.every((w) => w.pass) };
}

function markdown(summary) {
    const lines = [
        '| window | profile | runs (kills in window) | acknowledged | recovered acknowledged | missing acknowledged | duplicate logical writes | in-doubt retried → acked once | unacknowledged recovered / unacknowledged | committed prefixes identical | pass |',
        '|---|---|---:|---:|---:|---:|---:|---:|---:|:---:|:---:|',
    ];
    for (const w of summary.windows) {
        lines.push(`| ${w.label} | ${w.profile} | ${w.runs} (${w.killsInWindow}) | ${w.acknowledged} | ${w.recoveredAcknowledged} | `
            + `${w.missingAcknowledged} | ${w.duplicateLogicalWrites} | ${w.inDoubtRetriedAndAcknowledged} | ${w.unacknowledgedRecovered} / ${w.unacknowledged} | `
            + `${w.prefixesIdentical ? 'yes' : 'NO'} | ${w.pass ? 'PASS' : 'FAIL'} |`);
    }
    return lines.join('\n');
}

async function main() {
    const options = parseArgs(process.argv.slice(2), DEFAULTS, { strings: ['out', 'data-dir'], lists: { windows: String } });
    const windows = options.windows ? WINDOWS.filter((w) => options.windows.includes(w.id)) : WINDOWS;
    for (const window of windows) profileOptions(window.profile); // fail fast on a bad profile name
    const rng = new Rng(options.seed);
    fs.mkdirSync(options.out, { recursive: true });
    const results = [];
    const startedAt = new Date().toISOString();
    for (const window of windows) {
        for (let run = 0; run < options.runs; run += 1) {
            const result = await runOnce({ window, run, options, rng });
            results.push(result);
            const c = result.counts || {};
            process.stdout.write(`${window.id} run ${run + 1}/${options.runs}: ${result.pass ? 'PASS' : 'FAIL'} `
                + `victim=${result.victim} inWindow=${result.inWindow} acked=${c.acknowledged} missing=${c.missingAcknowledged} `
                + `dup=${c.duplicateLogicalWrites} inDoubtRetried=${c.inDoubtRetriedAndAcknowledged} unackedRecovered=${c.unacknowledgedRecovered}/${c.unacknowledged} `
                + `retried=${c.retriedWrites}${result.error ? ` error=${result.error}` : ''}\n`);
        }
    }
    const summary = summarize(results);
    const record = {
        schema: 'cloudproof.raft-durability-gate/v1',
        startedAt,
        finishedAt: new Date().toISOString(),
        git: gitState(),
        gate: 'missing acknowledged writes = 0 and duplicate logical writes = 0 in every window, every kill inside its window, identical committed prefixes',
        scope: 'process death of the leader (no OS crash); power loss is covered by sim/perf-faults.js',
        options: { ...options, out: undefined, 'data-dir': undefined },
        summary,
        runs: results,
    };
    fs.writeFileSync(path.join(options.out, 'results.json'), `${JSON.stringify(record, null, 2)}\n`);
    fs.writeFileSync(path.join(options.out, 'SUMMARY.md'), `# Durability gate\n\n${markdown(summary)}\n\nGate: ${summary.pass ? 'PASS' : 'FAIL'}\n`);
    process.stdout.write(`\n${markdown(summary)}\n\ngate: ${summary.pass ? 'PASS' : 'FAIL'}\n`);
    agent.destroy();
    if (!summary.pass) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = { WINDOWS };
