#!/usr/bin/env node
'use strict';

/**
 * multi-raft-live-test.js — the live half of the IV-B.0 gate
 * (CLOUDPROOF-PHASE-IV-B.md §13): three real Multi-Raft processes on loopback,
 * each hosting a replica of r1..r3 with fsynced files, HTTP transport only.
 *
 *   node tools/multi-raft-live-test.js [--profile optimized-http] [--base-port 17301] [--out report.json]
 *
 * In one recorded run:
 *   1. concurrent clients on all three ranges, retrying under the same
 *      LogicalRequestId;
 *   2. the leader of each range crashed in turn (that range replica only),
 *      while the other ranges must keep committing;
 *   3. a whole process SIGKILLed and restarted;
 *   4. mis-addressed writes and reads refused, with no state change;
 *   5. every process SIGKILLed and restarted: committed state must survive;
 *   6. logical linearizability per key, and exactly-once from the ledgers.
 * Only processes this script started are ever signalled.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const { RangeDirectory, staticDescriptors } = require('../packages/multi-raft/descriptors');
const { RangeRouter, ClientSession, logicalRequestId } = require('../packages/multi-raft/router');
const { HistoryRecorder } = require('../sim/linearizability');
const { checkLogicalLinearizability, checkExactlyOnce, gitProvenance } = require('../packages/multi-raft/gate-checks');

const ROOT = path.join(__dirname, '..');
const NODE_MAIN = path.join(ROOT, 'packages', 'multi-raft', 'node-main.js');
const BOUNDARIES = ['h', 'p'];
const KEYS = Object.freeze({
    r1: ['apple', 'cherry', 'date', 'fig'],
    r2: ['kiwi', 'lemon', 'mango', 'orange'],
    r3: ['pear', 'plum', 'quince', 'tomato'],
});
const ALL_KEYS = Object.values(KEYS).flat();
const RANGE_OF = Object.fromEntries(Object.entries(KEYS).flatMap(([r, keys]) => keys.map((k) => [k, r])));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
    const options = { profile: 'optimized-http', basePort: 17301, out: null, dataDir: path.join(ROOT, '.bench-data', 'multi-raft-live'), keep: false };
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i];
        const value = argv[i + 1];
        if (flag === '--profile') { options.profile = value; i += 1; } else if (flag === '--base-port') { options.basePort = Number(value); i += 1; } else if (flag === '--out') { options.out = value; i += 1; } else if (flag === '--data-dir') { options.dataDir = path.resolve(value); i += 1; } else if (flag === '--keep') options.keep = true;
        else throw new Error(`unknown argument ${flag}`);
    }
    return options;
}

async function fetchJson(url, { method = 'GET', body = null, timeoutMs = 3000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method, signal: controller.signal,
            headers: body ? { 'content-type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
    } finally {
        clearTimeout(timer);
    }
}

/** A connection that was refused never delivered the request: definitely not applied. */
const refused = (error) => error && error.cause && error.cause.code === 'ECONNREFUSED';

class LiveCluster {
    constructor({ basePort, dataDir, profile }) {
        this.nodeIds = ['n1', 'n2', 'n3'];
        this.ports = this.nodeIds.map((_, i) => basePort + i);
        this.origins = this.ports.map((p) => `http://127.0.0.1:${p}`);
        this.dataDir = dataDir;
        this.profile = profile;
        this.children = this.nodeIds.map(() => null);
        this.directory = new RangeDirectory(staticDescriptors({ boundaries: BOUNDARIES, replicas: this.nodeIds }));
        this.rangeIds = this.directory.all().map((d) => d.rangeId);
    }

    start(index) {
        const nodeId = this.nodeIds[index];
        fs.mkdirSync(this.dataDir, { recursive: true });
        const log = fs.openSync(path.join(this.dataDir, `${nodeId}.log`), 'a');
        const child = spawn(process.execPath, [NODE_MAIN], {
            env: {
                ...process.env,
                MR_NODE_ID: nodeId,
                MR_PORT: String(this.ports[index]),
                MR_ORIGINS: this.origins.join(','),
                MR_DATA_DIR: path.join(this.dataDir, nodeId),
                MR_BOUNDARIES: BOUNDARIES.join(','),
                MR_PROFILE: this.profile,
            },
            stdio: ['ignore', log, log],
            windowsHide: true,
        });
        fs.closeSync(log);
        const exited = new Promise((resolve) => child.once('exit', resolve));
        this.children[index] = { child, exited };
    }

    async kill(index) {
        const entry = this.children[index];
        if (!entry) return;
        entry.child.kill('SIGKILL');
        await entry.exited;
        this.children[index] = null;
    }

    async killAll() { await Promise.all(this.children.map((_, i) => this.kill(i))); }

    async status(index) {
        try { return (await fetchJson(`${this.origins[index]}/status`, { timeoutMs: 1000 })).body; } catch (_) { return null; }
    }

    /** Index of the node whose replica leads `rangeId` at the highest term, or -1. */
    async leaderIndex(rangeId) {
        let best = -1;
        let bestTerm = -1;
        const statuses = await Promise.all(this.nodeIds.map((_, i) => this.status(i)));
        statuses.forEach((s, i) => {
            const range = s && s.ranges.find((r) => r.rangeId === rangeId);
            if (range && range.leader && range.term > bestTerm) { best = i; bestTerm = range.term; }
        });
        return best;
    }

    async waitFor(predicate, timeoutMs = 20000, stepMs = 50) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await predicate()) return true;
            if (Date.now() > deadline) return false;
            await sleep(stepMs);
        }
    }

    async waitLeaders(rangeIds = this.rangeIds, timeoutMs = 20000) {
        return this.waitFor(async () => (await Promise.all(rangeIds.map((r) => this.leaderIndex(r)))).every((i) => i >= 0), timeoutMs);
    }

    admin(index, rangeId, action) {
        return fetchJson(`${this.origins[index]}/admin/ranges/${rangeId}/${action}`, { method: 'POST' });
    }

    async perReplica(kind) {
        const out = [];
        for (let i = 0; i < this.nodeIds.length; i += 1) {
            for (const rangeId of this.rangeIds) {
                try {
                    const response = await fetchJson(`${this.origins[i]}/ranges/${rangeId}/${kind}`, { timeoutMs: 5000 });
                    if (response.status === 200) out.push({ rangeId, nodeId: this.nodeIds[i], ...response.body });
                } catch (_) { /* down */ }
            }
        }
        return out;
    }

    /** Every replica of every range reachable and holding the same applied state. */
    /**
     * Every replica of every range reachable, at the same applied log
     * position, and holding the same state (equal state alone could hide a
     * replica that has not yet applied a rejected entry).
     */
    async converged() {
        const states = await this.perReplica('state');
        const statuses = await Promise.all(this.nodeIds.map((_, i) => this.status(i)));
        return this.rangeIds.every((rangeId) => {
            const replicas = states.filter((s) => s.rangeId === rangeId).map((s) => JSON.stringify(s.state));
            const ranges = statuses.map((s) => s && s.ranges.find((r) => r.rangeId === rangeId)).filter((r) => r && !r.crashed);
            const applied = new Set(ranges.map((r) => r.lastApplied));
            const commit = Math.max(...ranges.map((r) => r.commitIndex));
            return replicas.length === this.nodeIds.length && new Set(replicas).size === 1
                && ranges.length === this.nodeIds.length && applied.size === 1 && ranges[0].lastApplied === commit;
        });
    }

    async snapshot() {
        const states = await this.perReplica('state');
        return Object.fromEntries(this.rangeIds.map((r) => [r, (states.find((s) => s.rangeId === r) || {}).state || null]));
    }
}

/** Logical client over HTTP; same retry and history rules as the simulator's SimRangeClient. */
class LiveRangeClient {
    constructor({ cluster, history, clientId, process, retryDelayMs = 30, deadlineMs = 10000, attemptTimeoutMs = 3000 }) {
        this.cluster = cluster;
        this.history = history;
        this.router = new RangeRouter({ directory: cluster.directory });
        this.session = new ClientSession(clientId);
        this.process = process;
        this.retryDelayMs = retryDelayMs;
        this.deadlineMs = deadlineMs;
        this.attemptTimeoutMs = attemptTimeoutMs;
        this.hints = {};
        this.requests = [];
    }

    async origin(rangeId) {
        if (this.hints[rangeId]) return this.hints[rangeId];
        const index = await this.cluster.leaderIndex(rangeId);
        return index >= 0 ? (this.hints[rangeId] = this.cluster.origins[index]) : null;
    }

    async write(key, value, op = 'set') {
        const id = this.session.next();
        const record = {
            logicalRequestId: logicalRequestId(id), key, op, value, attempts: [], acknowledged: false, resultReturned: null,
            invokedAt: performance.now(), completedAt: null,
        };
        this.requests.push(record);
        this.history.invoke(this.process, op === 'delete' ? { kind: 'delete', key } : { kind: 'write', key, value });
        const deadline = performance.now() + this.deadlineMs;
        let mayHaveApplied = false;
        for (;;) {
            const request = this.router.request({ ...id, op, key, value });
            const origin = await this.origin(request.rangeId);
            let status = 'NO_LEADER';
            let body = null;
            if (origin) {
                try {
                    const response = await fetchJson(`${origin}/ranges/${request.rangeId}/kv`, { method: 'POST', body: request, timeoutMs: this.attemptTimeoutMs });
                    body = response.body;
                    status = body && body.status ? body.status : `HTTP_${response.status}`;
                } catch (error) {
                    status = refused(error) ? 'REFUSED' : 'UNKNOWN';
                }
            }
            record.attempts.push({ rangeId: request.rangeId, epoch: request.expectedRangeEpoch, status, duplicate: Boolean(body && body.duplicate), at: performance.now() });
            if (status === 'OK') {
                record.acknowledged = true;
                record.resultReturned = body.result;
                record.completedAt = performance.now();
                this.history.ok(this.process, true);
                return record;
            }
            if (status === 'NOT_LEADER') this.hints[request.rangeId] = body.leaderHint || null;
            else this.hints[request.rangeId] = null;
            if (status === 'UNKNOWN' || status.startsWith('HTTP_')) mayHaveApplied = true;
            if (status === 'STALE_RANGE_EPOCH' || performance.now() >= deadline) {
                record.completedAt = performance.now();
                if (mayHaveApplied) this.history.info(this.process); else this.history.fail(this.process);
                return record;
            }
            await sleep(this.retryDelayMs);
        }
    }

    async read(key) {
        this.history.invoke(this.process, { kind: 'read', key });
        const deadline = performance.now() + this.deadlineMs;
        for (;;) {
            const { rangeId, expectedRangeEpoch } = this.router.route(key);
            const origin = await this.origin(rangeId);
            if (origin) {
                try {
                    const response = await fetchJson(`${origin}/ranges/${rangeId}/kv/${encodeURIComponent(key)}?epoch=${expectedRangeEpoch}`, { timeoutMs: this.attemptTimeoutMs });
                    if (response.body && response.body.status === 'OK') { this.history.ok(this.process, response.body.value); return response.body.value; }
                    this.hints[rangeId] = response.body && response.body.status === 'NOT_LEADER' ? response.body.leaderHint : null;
                } catch (_) { this.hints[rangeId] = null; }
            }
            if (performance.now() >= deadline) { this.history.fail(this.process); return undefined; }
            await sleep(this.retryDelayMs);
        }
    }
}

const acknowledgedIn = (clients, rangeId, from, to) => clients.flatMap((c) => c.requests)
    .filter((r) => r.acknowledged && RANGE_OF[r.key] === rangeId && r.completedAt > from && r.completedAt < to).length;
/** Write attempts sent to a range in a window, by any client: was load even offered? */
const attemptsIn = (clients, rangeId, from, to) => clients.flatMap((c) => c.requests).flatMap((r) => r.attempts)
    .filter((a) => a.rangeId === rangeId && a.at > from && a.at < to).length;

async function campaign(options) {
    fs.rmSync(options.dataDir, { recursive: true, force: true });
    const cluster = new LiveCluster(options);
    const clock = { now: () => performance.now() };
    const history = new HistoryRecorder(clock);
    const report = { schema: 'cloudproof.multi-raft.iv-b0-live/v1', git: gitProvenance(), node: process.version, startedAt: new Date().toISOString(), profile: options.profile, steps: [] };
    const step = (name, data) => { report.steps.push({ name, at: new Date().toISOString(), ...data }); process.stdout.write(`[live] ${name} ${JSON.stringify(data)}\n`); };
    try {
        cluster.nodeIds.forEach((_, i) => cluster.start(i));
        step('started', { origins: cluster.origins, leaders: await cluster.waitLeaders() });

        // 1. Concurrent workload on all ranges.
        const clients = Array.from({ length: 6 }, (_, i) => new LiveRangeClient({ cluster, history, clientId: `live-c${i}`, process: `live-c${i}` }));
        let stop = false;
        // One dedicated writer per range, on that range's keys only, as in the
        // simulator's S1. Independent progress is measured on these. A shared
        // client blocked on a leaderless range stops offering load to every
        // range: head-of-line blocking in the workload, not in the system. The
        // first recording measured progress on the shared clients and failed
        // that way (RESULT.md).
        const writers = cluster.rangeIds.map((rangeId) => new LiveRangeClient({
            cluster, history, clientId: `live-w-${rangeId}`, process: `live-w-${rangeId}`,
        }));
        const writerFor = (rangeId) => writers[cluster.rangeIds.indexOf(rangeId)];
        const everyone = [...clients, ...writers];
        const progress = (rangeId, from, to) => ({
            writer: acknowledgedIn([writerFor(rangeId)], rangeId, from, to),
            sharedClients: acknowledgedIn(clients, rangeId, from, to),
            offeredAttempts: attemptsIn(everyone, rangeId, from, to),
        });
        let x = 0x51ed2701;
        const pick = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
        const workers = clients.map(async (client) => {
            for (let n = 0; !stop; n += 1) {
                const key = ALL_KEYS[pick() % ALL_KEYS.length];
                if (pick() % 10 < 7) await client.write(key, `${client.session.clientId}:${n}`);
                else await client.read(key);
            }
        });
        const writerLoops = writers.map(async (writer, i) => {
            const keys = KEYS[cluster.rangeIds[i]];
            for (let n = 0; !stop; n += 1) await writer.write(keys[n % keys.length], `${writer.session.clientId}:${n}`);
        });
        await sleep(2000);

        // 2. Each range's leader replica crashed in turn.
        const windows = [];
        for (const rangeId of cluster.rangeIds) {
            const leader = await cluster.leaderIndex(rangeId);
            const crashedAt = performance.now();
            await cluster.admin(leader, rangeId, 'crash');
            const elected = await cluster.waitFor(async () => { const i = await cluster.leaderIndex(rangeId); return i >= 0 && i !== leader; }, 20000, 20);
            const electedAt = performance.now();
            const others = cluster.rangeIds.filter((r) => r !== rangeId);
            const window = {
                kind: 'range-leader-crash', rangeId, crashedNode: cluster.nodeIds[leader], elected, leaderlessMs: Math.round(electedAt - crashedAt),
                newLeaderNode: cluster.nodeIds[await cluster.leaderIndex(rangeId)],
                committedByOtherRanges: Object.fromEntries(others.map((r) => [r, acknowledgedIn([writerFor(r)], r, crashedAt, electedAt)])),
                diagnostics: Object.fromEntries(others.map((r) => [r, progress(r, crashedAt, electedAt)])),
            };
            windows.push(window);
            step('range leader crashed', window);
            await cluster.admin(leader, rangeId, 'restart');
            await sleep(1500);
        }

        // 3. A whole process killed and restarted.
        // The victim leads some ranges but not all, when such a node exists,
        // so the window shows the ranges led elsewhere committing through it.
        const leaders = Object.fromEntries(await Promise.all(cluster.rangeIds.map(async (r) => [r, await cluster.leaderIndex(r)])));
        const ledCount = (i) => cluster.rangeIds.filter((r) => leaders[r] === i).length;
        const candidates = cluster.nodeIds.map((_, i) => i).filter((i) => ledCount(i) > 0);
        const victim = candidates.find((i) => ledCount(i) < cluster.rangeIds.length) ?? candidates[0];
        const killedAt = performance.now();
        await cluster.kill(victim);
        const ledHere = cluster.rangeIds.filter((r) => leaders[r] === victim);
        const ledElsewhere = cluster.rangeIds.filter((r) => leaders[r] !== victim);
        const reelected = await cluster.waitLeaders(ledHere, 20000);
        const reelectedAt = performance.now();
        const nodeWindow = {
            kind: 'process-kill', killedNode: cluster.nodeIds[victim], rangesLedByKilledNode: ledHere, elected: reelected,
            leaderlessMs: Math.round(reelectedAt - killedAt),
            vacuous: ledElsewhere.length === 0,
            committedByRangesLedElsewhere: Object.fromEntries(ledElsewhere.map((r) => [r, acknowledgedIn([writerFor(r)], r, killedAt, reelectedAt)])),
            diagnostics: Object.fromEntries(ledElsewhere.map((r) => [r, progress(r, killedAt, reelectedAt)])),
        };
        windows.push(nodeWindow);
        step('process killed', nodeWindow);
        cluster.start(victim);
        await cluster.waitFor(async () => Boolean(await cluster.status(victim)), 20000);
        await sleep(2000);

        stop = true;
        await Promise.all([...workers, ...writerLoops]);
        step('workload stopped', { logicalWrites: everyone.reduce((t, c) => t + c.requests.length, 0) });

        // 4. Fencing: mis-addressed writes and reads refused, nothing changes.
        const settled = await cluster.waitFor(() => cluster.converged(), 20000, 200);
        const before = await cluster.snapshot();
        const probes = [];
        let seq = 0;
        for (let i = 0; i < cluster.nodeIds.length; i += 1) {
            for (const rangeId of cluster.rangeIds) {
                const key = KEYS[rangeId][0];
                const other = cluster.rangeIds.find((r) => r !== rangeId);
                for (const probe of [
                    { why: 'stale epoch 2', rangeId, expectedRangeEpoch: 2, key },
                    { why: 'stale epoch 0', rangeId, expectedRangeEpoch: 0, key },
                    { why: 'wrong range', rangeId: other, expectedRangeEpoch: 1, key },
                    { why: 'key outside range', rangeId, expectedRangeEpoch: 1, key: KEYS[other][0] },
                ]) {
                    seq += 1;
                    const write = await fetchJson(`${cluster.origins[i]}/ranges/${probe.rangeId}/kv`, {
                        method: 'POST', body: { ...probe, clientId: 'live-probe', seqNo: seq, op: 'set', value: 'PROBE' },
                    });
                    const read = await fetchJson(`${cluster.origins[i]}/ranges/${probe.rangeId}/kv/${probe.key}?epoch=${probe.expectedRangeEpoch}`);
                    probes.push({ ...probe, node: cluster.nodeIds[i], http: write.status, status: write.body && write.body.status, readHttp: read.status });
                }
            }
        }
        await sleep(1000);
        const after = await cluster.snapshot();
        const fencing = {
            probes: probes.length,
            writesRefused: probes.filter((p) => p.http === 409 && p.status === 'STALE_RANGE_EPOCH').length,
            readsRefused: probes.filter((p) => p.readHttp === 409).length,
            stateUnchanged: JSON.stringify(before) === JSON.stringify(after),
        };
        step('fencing probes', { convergedBefore: settled, ...fencing });

        // 5. Every process killed and restarted: committed state must survive.
        await cluster.killAll();
        cluster.nodeIds.forEach((_, i) => cluster.start(i));
        const backUp = await cluster.waitLeaders(cluster.rangeIds, 30000);
        const reconverged = await cluster.waitFor(() => cluster.converged(), 30000, 200);
        const restored = await cluster.snapshot();
        const durability = { leadersAfterRestart: backUp, converged: reconverged, stateSurvived: JSON.stringify(restored) === JSON.stringify(after) };
        step('full restart', durability);

        // 6. Final reads, ledgers, and both gates.
        const reader = new LiveRangeClient({ cluster, history, clientId: 'live-final', process: 'live-final' });
        for (const key of ALL_KEYS) await reader.read(key);
        const ledgers = (await cluster.perReplica('ledger')).map(({ rangeId, nodeId, ledger }) => ({ rangeId, nodeId, ledger }));
        const linearizability = checkLogicalLinearizability(history.events);
        const exactlyOnce = checkExactlyOnce({
            requests: everyone.flatMap((c) => c.requests),
            replicaLedgers: ledgers,
            probes: probes.map((p) => ({ status: p.status })),
        });
        // A vacuous window (the killed process led every range) is reported but
        // proves nothing either way; the per-range windows are always evidence.
        const independent = windows.every((w) => w.elected
            && (w.vacuous || Object.values(w.committedByOtherRanges || w.committedByRangesLedElsewhere).every((count) => count >= 1)));
        report.windows = windows;
        report.fencing = fencing;
        report.durability = durability;
        report.linearizability = {
            ok: linearizability.ok, keys: linearizability.keys, operations: linearizability.operations,
            violations: linearizability.violations, inconclusive: linearizability.inconclusive,
        };
        report.exactlyOnce = { ok: exactlyOnce.ok, counts: exactlyOnce.counts, appliedMoreThanOnce: exactlyOnce.appliedMoreThanOnce, missingAcknowledged: exactlyOnce.missingAcknowledged };
        report.history = history.summary();
        report.conditions = {
            concurrencyOnThreeRanges: cluster.rangeIds.every((r) => everyone.some((c) => c.requests.some((q) => q.acknowledged && RANGE_OF[q.key] === r))),
            independentLeaderFailure: windows.filter((w) => w.kind === 'range-leader-crash').length === cluster.rangeIds.length && windows.every((w) => w.elected),
            independentProgress: independent,
            fencing: fencing.writesRefused === fencing.probes && fencing.readsRefused === fencing.probes && fencing.stateUnchanged,
            durability: durability.leadersAfterRestart && durability.converged && durability.stateSurvived,
            logicalLinearizability: linearizability.ok,
            exactlyOnce: exactlyOnce.ok,
        };
        report.ok = Object.values(report.conditions).every(Boolean);
        return report;
    } finally {
        await cluster.killAll();
        report.finishedAt = new Date().toISOString();
        if (report.ok && !options.keep) fs.rmSync(options.dataDir, { recursive: true, force: true });
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const report = await campaign(options);
    process.stdout.write(`[live] conditions ${JSON.stringify(report.conditions)}\n`);
    process.stdout.write(`[live] exactly-once ${JSON.stringify(report.exactlyOnce.counts)}\n`);
    process.stdout.write(`[live] linearizability keys=${report.linearizability.keys} operations=${report.linearizability.operations} violations=${report.linearizability.violations.length} inconclusive=${report.linearizability.inconclusive.length}\n`);
    if (options.out) {
        fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
        fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`IV-B.0 live gate: ${report.ok ? 'PASS' : 'FAIL'}\n`);
    if (!report.ok) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { campaign, LiveCluster, LiveRangeClient };
