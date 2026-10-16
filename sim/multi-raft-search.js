#!/usr/bin/env node
'use strict';

/**
 * multi-raft-search.js — the deterministic half of the IV-B.0 gate
 * (CLOUDPROOF-PHASE-IV-B.md §13): targeted scenarios plus a seeded random
 * fault campaign over three static ranges on three simulated nodes.
 *
 *   node sim/multi-raft-search.js --runs 50 --profile baseline --out <report.json>
 *
 * Every run ends with recovery and convergence, then is judged on:
 *   - logical linearizability, per key, of the combined client history (§5.1)
 *   - exactly-once from the ranges' application ledgers (§5.2)
 *   - per-range Log Matching and committed-prefix agreement
 *   - static descriptors (I1-I3) and replica convergence
 * and the scenarios add their own conditions (independent progress while
 * another range elects, state surviving restart, fencing with no mutation).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Rng } = require('./simulator');
const { SimMultiRaftCluster, SimRangeClient, HistoryRecorder } = require('./multi-raft-cluster');
const { checkLogicalLinearizability, checkExactlyOnce, gitProvenance } = require('../packages/multi-raft/gate-checks');

const KEYS = Object.freeze({
    r1: ['apple', 'cherry', 'date', 'fig'],
    r2: ['kiwi', 'lemon', 'mango', 'orange'],
    r3: ['pear', 'plum', 'quince', 'tomato'],
});
const ALL_KEYS = Object.freeze(Object.values(KEYS).flat());
const PROFILES = Object.freeze(['baseline', 'optimized-http', 'batched-delay']);

/** Advances virtual time until `promise` settles (or `maxMs` passes), then returns it. */
async function drive(cluster, promise, maxMs = 30000) {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    const deadline = cluster.clock.now() + maxMs;
    while (!done && cluster.clock.now() < deadline) await cluster.tick(10);
    if (!done) throw new Error(`simulation did not settle within ${maxMs} ms of virtual time`);
    return promise;
}

/** Advances virtual time until `predicate()` holds; returns whether it did (a boolean, never the predicate's value). */
async function tickUntil(cluster, predicate, maxMs = 10000, stepMs = 5) {
    const deadline = cluster.clock.now() + maxMs;
    while (!predicate() && cluster.clock.now() < deadline) await cluster.tick(stepMs);
    return Boolean(predicate());
}

function fingerprint(history, ledgers) {
    return crypto.createHash('sha256').update(JSON.stringify({ history: history.events, ledgers })).digest('hex');
}

/**
 * Recovery, convergence and the common judgement. `requests` and `probes` are
 * everything the run sent; final reads by a fresh client anchor the history.
 */
async function finish({ cluster, history, clients, probes = [] }) {
    cluster.recoverAll();
    await tickUntil(cluster, () => cluster.rangeIds.every((r) => cluster.leaderOf(r)), 15000);
    const reader = new SimRangeClient({ cluster, history, clientId: 'final-reader', process: 'final-reader' });
    for (const key of ALL_KEYS) await drive(cluster, reader.read(key));
    const converged = await tickUntil(cluster, () => cluster.converged(), 15000, 20);
    const requests = clients.flatMap((c) => c.requests);
    const ledgers = cluster.replicaLedgers();
    const linearizability = checkLogicalLinearizability(history.events);
    const exactlyOnce = checkExactlyOnce({ requests, replicaLedgers: ledgers, probes });
    const ranges = cluster.checkRanges();
    return {
        ok: linearizability.ok && exactlyOnce.ok && ranges.ok && converged,
        linearizability: {
            ok: linearizability.ok, keys: linearizability.keys, operations: linearizability.operations,
            violations: linearizability.violations, inconclusive: linearizability.inconclusive,
        },
        exactlyOnce: { ok: exactlyOnce.ok, counts: exactlyOnce.counts, appliedMoreThanOnce: exactlyOnce.appliedMoreThanOnce, missingAcknowledged: exactlyOnce.missingAcknowledged },
        ranges,
        converged,
        history: history.summary(),
        fingerprint: fingerprint(history, ledgers),
    };
}

/** One writer per range, back to back on its own keys, until stopped. */
function startRangeWriters(cluster, history, { tag }) {
    const state = { stop: false };
    const clients = cluster.rangeIds.map((rangeId) => new SimRangeClient({
        cluster, history, clientId: `${tag}-${rangeId}`, process: `${tag}-${rangeId}`,
    }));
    const done = Promise.all(clients.map(async (client, i) => {
        const keys = KEYS[cluster.rangeIds[i]];
        for (let n = 0; !state.stop; n += 1) await client.write(keys[n % keys.length], `${client.session.clientId}:${n}`);
    }));
    return { state, clients, done };
}

const acknowledgedIn = (client, from, to) => client.requests.filter((r) => r.acknowledged && r.completedAt > from && r.completedAt < to).length;

/**
 * S1 — independent leader failure. The leader of each range is crashed in
 * turn (only that range replica); while that range elects, every other range
 * must keep committing. Then a whole node is crashed: ranges led elsewhere
 * must keep committing through it.
 */
async function scenarioIndependentLeaders({ seed = 1, profile = 'baseline' } = {}) {
    const cluster = new SimMultiRaftCluster({ seed, profile });
    const history = new HistoryRecorder(cluster.clock);
    await tickUntil(cluster, () => cluster.rangeIds.every((r) => cluster.leaderOf(r)), 10000);
    const writers = startRangeWriters(cluster, history, { tag: 's1' });
    await cluster.tick(600);
    const windows = [];
    for (const rangeId of cluster.rangeIds) {
        const leader = cluster.leaderOf(rangeId);
        const crashedAt = cluster.clock.now();
        cluster.crashGroup(leader.index, rangeId);
        const elected = await tickUntil(cluster, () => cluster.leaderOf(rangeId), 10000, 2);
        const electedAt = cluster.clock.now();
        const successor = cluster.leaderOf(rangeId);
        const others = cluster.rangeIds.filter((r) => r !== rangeId);
        windows.push({
            kind: 'range-leader-crash',
            rangeId,
            crashedNode: cluster.nodeIds[leader.index],
            newLeaderNode: successor ? cluster.nodeIds[successor.index] : null,
            elected,
            leaderlessMs: electedAt - crashedAt,
            committedByOtherRanges: Object.fromEntries(others.map((r) => [r, acknowledgedIn(writers.clients[cluster.rangeIds.indexOf(r)], crashedAt, electedAt)])),
        });
        cluster.restartGroup(leader.index, rangeId);
        await cluster.tick(600);
    }
    // A whole-node crash: every range replica on that node dies at once. The
    // victim is a node that leads some ranges but not all, when one exists, so
    // the window can show the ranges led elsewhere committing through it.
    const leaders = Object.fromEntries(cluster.rangeIds.map((r) => [r, cluster.leaderOf(r).index]));
    const ledCount = (i) => cluster.rangeIds.filter((r) => leaders[r] === i).length;
    const candidates = cluster.nodeIds.map((_, i) => i).filter((i) => ledCount(i) > 0);
    const victim = candidates.find((i) => ledCount(i) < cluster.rangeIds.length) ?? candidates[0];
    const crashedAt = cluster.clock.now();
    cluster.crashNode(victim);
    const ledHere = cluster.rangeIds.filter((r) => leaders[r] === victim);
    const ledElsewhere = cluster.rangeIds.filter((r) => leaders[r] !== victim);
    const elected = await tickUntil(cluster, () => ledHere.every((r) => cluster.leaderOf(r)), 10000, 2);
    const electedAt = cluster.clock.now();
    windows.push({
        kind: 'node-crash',
        crashedNode: cluster.nodeIds[victim],
        rangesLedByCrashedNode: ledHere,
        elected,
        leaderlessMs: electedAt - crashedAt,
        vacuous: ledElsewhere.length === 0,
        committedByRangesLedElsewhere: Object.fromEntries(ledElsewhere.map((r) => [r, acknowledgedIn(writers.clients[cluster.rangeIds.indexOf(r)], crashedAt, electedAt)])),
    });
    cluster.restartNode(victim);
    await cluster.tick(600);
    writers.state.stop = true;
    await drive(cluster, writers.done);
    const verdict = await finish({ cluster, history, clients: writers.clients });
    // A window whose crash left no range with a live leader elsewhere proves
    // nothing about independence; it is reported, never counted as evidence.
    const independent = windows.every((w) => w.elected && w.leaderlessMs > 0
        && (w.vacuous || Object.values(w.committedByOtherRanges || w.committedByRangesLedElsewhere).every((count) => count >= 1)))
        && windows.filter((w) => w.kind === 'range-leader-crash').length === cluster.rangeIds.length;
    cluster.stop();
    // Scenario conditions decide `ok`; the common verdict is spread first so
    // it cannot overwrite them.
    return { ...verdict, scenario: 'S1-independent-leaders', seed, profile, ok: verdict.ok && independent, independent, windows };
}

/** S2 — every range's committed state survives a crash of every node. */
async function scenarioDurability({ seed = 2, profile = 'baseline' } = {}) {
    const cluster = new SimMultiRaftCluster({ seed, profile });
    const history = new HistoryRecorder(cluster.clock);
    await tickUntil(cluster, () => cluster.rangeIds.every((r) => cluster.leaderOf(r)), 10000);
    const client = new SimRangeClient({ cluster, history, clientId: 's2', process: 's2' });
    const acknowledged = {};
    for (let n = 0; n < 3; n += 1) {
        for (const key of ALL_KEYS) {
            const value = `s2:${key}:${n}`;
            const record = await drive(cluster, client.write(key, value));
            if (record.acknowledged) acknowledged[key] = value;
        }
    }
    await tickUntil(cluster, () => cluster.converged(), 10000, 20);
    const before = Object.fromEntries(cluster.rangeIds.map((r) => [r, cluster.nodes[0].state(r)]));
    cluster.nodes.forEach((_, i) => cluster.crashNode(i));
    await cluster.tick(200);
    cluster.nodes.forEach((_, i) => cluster.restartNode(i));
    const elected = await tickUntil(cluster, () => cluster.rangeIds.every((r) => cluster.leaderOf(r)), 15000);
    const reread = {};
    const reader = new SimRangeClient({ cluster, history, clientId: 's2-reread', process: 's2-reread' });
    for (const key of ALL_KEYS) reread[key] = await drive(cluster, reader.read(key));
    const survived = Object.entries(acknowledged).every(([key, value]) => reread[key] === value);
    await tickUntil(cluster, () => cluster.converged(), 10000, 20);
    const after = Object.fromEntries(cluster.rangeIds.map((r) => [r, cluster.nodes[0].state(r)]));
    const stateSurvived = JSON.stringify(after) === JSON.stringify(before);
    const verdict = await finish({ cluster, history, clients: [client] });
    cluster.stop();
    return {
        ...verdict,
        scenario: 'S2-durability-across-restart', seed, profile, ok: verdict.ok && elected && survived && stateSurvived,
        acknowledgedWrites: Object.keys(acknowledged).length, survived, stateSurvived,
    };
}

/**
 * S3 — fencing. Mis-addressed writes are refused at admission on leaders and
 * followers; the same writes appended raw (bypassing admission, as a write an
 * old leader admitted before a change would be) are rejected at apply on
 * every replica. Nothing changes state.
 */
async function scenarioFencing({ seed = 3, profile = 'baseline' } = {}) {
    const cluster = new SimMultiRaftCluster({ seed, profile });
    const history = new HistoryRecorder(cluster.clock);
    await tickUntil(cluster, () => cluster.rangeIds.every((r) => cluster.leaderOf(r)), 10000);
    const client = new SimRangeClient({ cluster, history, clientId: 's3', process: 's3' });
    for (const key of ALL_KEYS) await drive(cluster, client.write(key, `s3:${key}`));
    await tickUntil(cluster, () => cluster.converged(), 5000, 20);
    const statesBefore = JSON.stringify(cluster.nodes.map((n) => cluster.rangeIds.map((r) => n.state(r))));
    const probes = [];
    let seq = 0;
    const misaddressed = (rangeId) => {
        const key = KEYS[rangeId][0];
        const other = cluster.rangeIds.find((r) => r !== rangeId);
        return [
            { why: 'stale epoch 2', rangeId, expectedRangeEpoch: 2, key },
            { why: 'stale epoch 0', rangeId, expectedRangeEpoch: 0, key },
            { why: 'wrong range', rangeId: other, expectedRangeEpoch: 1, key },
            { why: 'key outside range', rangeId, expectedRangeEpoch: 1, key: KEYS[other][0] },
        ];
    };
    for (const rangeId of cluster.rangeIds) {
        for (const node of cluster.nodes) {
            for (const probe of misaddressed(rangeId)) {
                seq += 1;
                const outcome = await drive(cluster, node.write({ ...probe, clientId: 'probe', seqNo: seq, op: 'set', value: 'PROBE' }));
                probes.push({ ...probe, path: 'admission', node: node.nodeId, status: outcome.status, at: outcome.at });
            }
        }
        // The same four writes appended raw into this range's own log: every
        // one, including the one addressed to another range, must be
        // rejected at apply.
        const leader = cluster.leaderOf(rangeId);
        for (const probe of misaddressed(rangeId)) {
            seq += 1;
            const outcome = await drive(cluster, leader.group.raft.clientAppend({
                op: 'set', key: probe.key, value: 'PROBE', clientId: 'probe', seqNo: seq,
                rangeId: probe.rangeId, expectedRangeEpoch: probe.expectedRangeEpoch,
            }));
            const status = outcome.committed ? (outcome.result && outcome.result.ok ? 'OK' : 'REJECTED_AT_APPLY') : 'UNKNOWN';
            probes.push({ ...probe, path: 'apply', targetRange: rangeId, node: leader.node.nodeId, status, error: outcome.result && outcome.result.error });
        }
    }
    await tickUntil(cluster, () => cluster.converged(), 5000, 20);
    const statesAfter = JSON.stringify(cluster.nodes.map((n) => cluster.rangeIds.map((r) => n.state(r))));
    const applyProbes = probes.filter((p) => p.path === 'apply');
    const rejectedOnEveryReplica = cluster.rangeIds.every((rangeId) => cluster.nodes.every((node) => {
        const rejected = node.ledger(rangeId).filter((row) => row.outcome === 'rejected' && row.clientId === 'probe');
        return rejected.length === applyProbes.filter((p) => p.targetRange === rangeId).length;
    }));
    const allRefused = probes.every((p) => (p.path === 'admission' ? p.status === 'STALE_RANGE_EPOCH' : p.status === 'REJECTED_AT_APPLY'));
    const verdict = await finish({ cluster, history, clients: [client], probes });
    cluster.stop();
    return {
        ...verdict,
        scenario: 'S3-fencing', seed, profile,
        ok: verdict.ok && allRefused && rejectedOnEveryReplica && statesAfter === statesBefore,
        probes: probes.length, admissionProbes: probes.length - applyProbes.length, applyProbes: applyProbes.length,
        allRefused, rejectedOnEveryReplica, stateUnchanged: statesAfter === statesBefore,
    };
}

/**
 * S4 — exactly-once under retry. Every write's first attempt is abandoned
 * after 1 ms of virtual time while it is still in flight, and the write is
 * retried under the same LogicalRequestId. The original usually commits, so
 * the retry must be answered by deduplication, not applied again. This is the
 * case a register checker cannot see (§5.2): a value written twice is still
 * the same value.
 */
async function scenarioRetryAfterUnknown({ seed = 4, profile = 'baseline' } = {}) {
    const cluster = new SimMultiRaftCluster({ seed, profile });
    const history = new HistoryRecorder(cluster.clock);
    await tickUntil(cluster, () => cluster.rangeIds.every((r) => cluster.leaderOf(r)), 10000);
    const client = new SimRangeClient({ cluster, history, clientId: 's4', process: 's4', firstAttemptTimeoutMs: 1 });
    for (let n = 0; n < 2; n += 1) {
        for (const key of ALL_KEYS) await drive(cluster, client.write(key, `s4:${key}:${n}`));
    }
    const retried = client.requests.filter((r) => r.attempts.length > 1).length;
    const answeredByDedup = client.requests.filter((r) => r.attempts.some((a) => a.duplicate)).length;
    const verdict = await finish({ cluster, history, clients: [client] });
    cluster.stop();
    return {
        ...verdict,
        scenario: 'S4-retry-after-unknown', seed, profile,
        ok: verdict.ok && retried === client.requests.length && answeredByDedup > 0,
        writes: client.requests.length, retried, answeredByDedup,
    };
}

/**
 * The random campaign: six clients on all twelve keys, with retries under the
 * same LogicalRequestId, against range-leader crashes, node crashes,
 * partitions, packet loss and fencing probes.
 */
async function runCampaignSeed({ seed, profile = 'baseline', durationMs = 6000, clients: clientCount = 6 } = {}) {
    const cluster = new SimMultiRaftCluster({ seed, profile });
    const rng = new Rng((seed * 0x5bd1e995 + 1) >>> 0);
    const history = new HistoryRecorder(cluster.clock);
    await tickUntil(cluster, () => cluster.rangeIds.every((r) => cluster.leaderOf(r)), 10000);
    const end = cluster.clock.now() + durationMs;
    const clients = Array.from({ length: clientCount }, (_, i) => new SimRangeClient({
        cluster, history, clientId: `c${i}`, process: `c${i}`,
    }));
    const workers = clients.map(async (client) => {
        for (let n = 0; cluster.clock.now() < end; n += 1) {
            const key = rng.pick(ALL_KEYS);
            if (rng.chance(0.7)) await client.write(key, `${client.session.clientId}:${n}`);
            else await client.read(key);
            await cluster.sleep(rng.range(0, 60));
        }
    });
    const probes = [];
    const faults = [];
    let probeSeq = 0;
    while (cluster.clock.now() < end) {
        await cluster.tick(rng.range(150, 450));
        const roll = rng.int(100);
        const downNodes = cluster.nodes.map((n, i) => (n ? null : i)).filter((i) => i !== null);
        if (roll < 22) {
            const rangeId = rng.pick(cluster.rangeIds);
            const leader = cluster.leaderOf(rangeId);
            if (leader && cluster.crashGroup(leader.index, rangeId)) faults.push(['crash-range-leader', rangeId, leader.index]);
        } else if (roll < 40) {
            const crashed = [];
            cluster.nodes.forEach((node, i) => node && cluster.rangeIds.forEach((r) => node.groups.get(r).crashed && crashed.push([i, r])));
            if (crashed.length) { const [i, r] = rng.pick(crashed); cluster.restartGroup(i, r); faults.push(['restart-range', r, i]); }
        } else if (roll < 50) {
            if (downNodes.length === 0) { const i = rng.int(cluster.nodes.length); cluster.crashNode(i); faults.push(['crash-node', i]); }
        } else if (roll < 62) {
            if (downNodes.length) { const i = rng.pick(downNodes); cluster.restartNode(i); faults.push(['restart-node', i]); }
        } else if (roll < 70) {
            const i = rng.int(cluster.nodes.length);
            cluster.partition([[i], cluster.nodes.map((_, j) => j).filter((j) => j !== i)]);
            faults.push(['isolate', i]);
        } else if (roll < 80) {
            cluster.heal(); faults.push(['heal']);
        } else if (roll < 86) {
            cluster.network.dropRate = rng.pick([0, 0.02, 0.05]); faults.push(['loss', cluster.network.dropRate]);
        } else {
            const rangeId = rng.pick(cluster.rangeIds);
            const leader = cluster.leaderOf(rangeId);
            if (leader) {
                probeSeq += 1;
                const raw = rng.chance(0.5);
                const bad = { op: 'set', key: KEYS[rangeId][0], value: 'PROBE', clientId: 'probe', seqNo: probeSeq, rangeId, expectedRangeEpoch: 2 };
                const pending = raw ? leader.group.raft.clientAppend(bad) : leader.node.write(bad);
                pending.then((outcome) => {
                    const status = raw
                        ? (outcome.committed ? (outcome.result && outcome.result.ok ? 'OK' : 'REJECTED_AT_APPLY') : 'UNKNOWN')
                        : outcome.status;
                    probes.push({ path: raw ? 'apply' : 'admission', rangeId, status });
                }, () => probes.push({ path: raw ? 'apply' : 'admission', rangeId, status: 'ERROR' }));
                faults.push(['probe', rangeId, raw ? 'apply' : 'admission']);
            }
        }
    }
    await drive(cluster, Promise.all(workers), 60000);
    const verdict = await finish({ cluster, history, clients, probes });
    cluster.stop();
    return { scenario: 'campaign', seed, profile, faults: faults.length, faultKinds: countKinds(faults), ...verdict };
}

function countKinds(faults) {
    const counts = {};
    for (const [kind] of faults) counts[kind] = (counts[kind] || 0) + 1;
    return counts;
}

/** Quiet: the engine logs every election and commit, thousands of lines per run. */
async function quietly(task) {
    const { log } = console;
    console.log = () => {};
    try { return await task(); } finally { console.log = log; }
}

function summarize(results) {
    const sum = (field) => results.reduce((t, r) => t + (r.exactlyOnce.counts[field] || 0), 0);
    return {
        runs: results.length,
        passed: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).map((r) => ({ scenario: r.scenario, seed: r.seed, profile: r.profile })),
        linearizabilityKeysChecked: results.reduce((t, r) => t + r.linearizability.keys, 0),
        operationsChecked: results.reduce((t, r) => t + r.linearizability.operations, 0),
        linearizabilityViolations: results.reduce((t, r) => t + r.linearizability.violations.length, 0),
        linearizabilityInconclusive: results.reduce((t, r) => t + r.linearizability.inconclusive.length, 0),
        logicalRequests: sum('requests'),
        acknowledged: sum('acknowledged'),
        retried: sum('retried'),
        appliedMoreThanOnce: sum('appliedMoreThanOnce'),
        duplicateLogicalWrites: sum('duplicateLogicalWrites'),
        missingAcknowledged: sum('missingAcknowledged'),
        unacknowledgedApplied: sum('unacknowledgedApplied'),
        staleEpochWritesAccepted: sum('staleEpochWritesAccepted'),
        probes: sum('probes'),
        unrequestedApplications: sum('unrequestedApplications'),
        ledgerDisagreements: sum('ledgerDisagreements'),
        rangeSafetyProblems: results.reduce((t, r) => t + r.ranges.problems.length, 0),
        notConverged: results.filter((r) => !r.converged).length,
    };
}

async function runGate({ runs = 20, firstSeed = 1, profiles = PROFILES, onResult = () => {} } = {}) {
    const report = { schema: 'cloudproof.multi-raft.iv-b0-sim/v1', git: gitProvenance(), node: process.version, runs, firstSeed, profiles: {} };
    for (const profile of profiles) {
        const scenarios = [];
        for (const run of [scenarioIndependentLeaders, scenarioDurability, scenarioFencing, scenarioRetryAfterUnknown]) {
            const result = await quietly(() => run({ profile }));
            onResult(result);
            scenarios.push(result);
        }
        const campaign = [];
        for (let seed = firstSeed; seed < firstSeed + runs; seed += 1) {
            const result = await quietly(() => runCampaignSeed({ seed, profile }));
            onResult(result);
            campaign.push(result);
        }
        report.profiles[profile] = {
            scenarios: scenarios.map(({ fingerprint: _f, ...rest }) => rest),
            campaign: { summary: summarize(campaign), seeds: campaign.map((r) => ({ seed: r.seed, ok: r.ok, faults: r.faultKinds, counts: r.exactlyOnce.counts, history: r.history, fingerprint: r.fingerprint })) },
            ok: scenarios.every((s) => s.ok) && campaign.every((r) => r.ok),
        };
    }
    report.ok = Object.values(report.profiles).every((p) => p.ok);
    return report;
}

function parseArgs(argv) {
    const options = { runs: 20, seed: 1, profile: null, out: null };
    for (let i = 0; i < argv.length; i += 1) {
        const [flag, value] = [argv[i], argv[i + 1]];
        if (flag === '--runs') { options.runs = Number(value); i += 1; } else if (flag === '--seed') { options.seed = Number(value); i += 1; } else if (flag === '--profile') { options.profile = value; i += 1; } else if (flag === '--out') { options.out = value; i += 1; } else throw new Error(`unknown argument ${flag}`);
    }
    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const profiles = options.profile ? options.profile.split(',') : PROFILES;
    const report = await runGate({
        runs: options.runs, firstSeed: options.seed, profiles,
        onResult: (r) => process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'} ${r.profile} ${r.scenario}${r.scenario === 'campaign' ? ` seed=${r.seed}` : ''} `
            + `ops=${r.linearizability.operations} acked=${r.exactlyOnce.counts.acknowledged} retried=${r.exactlyOnce.counts.retried} `
            + `appliedTwice=${r.exactlyOnce.counts.appliedMoreThanOnce} missingAcked=${r.exactlyOnce.counts.missingAcknowledged} `
            + `staleAccepted=${r.exactlyOnce.counts.staleEpochWritesAccepted} linViolations=${r.linearizability.violations.length}\n`),
    });
    for (const [profile, result] of Object.entries(report.profiles)) {
        process.stdout.write(`${profile}: ${result.ok ? 'PASS' : 'FAIL'} ${JSON.stringify(result.campaign.summary)}\n`);
    }
    if (options.out) {
        fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
        fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`IV-B.0 simulator gate: ${report.ok ? 'PASS' : 'FAIL'}\n`);
    if (!report.ok) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = {
    KEYS, ALL_KEYS, PROFILES, drive, tickUntil, finish, scenarioIndependentLeaders, scenarioDurability, scenarioFencing, scenarioRetryAfterUnknown,
    runCampaignSeed, runGate, summarize, quietly,
};
