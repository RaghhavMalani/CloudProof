#!/usr/bin/env node
'use strict';

/**
 * perf-faults.js — targeted fault campaign for the Phase IV-A optimizations.
 *
 * The general schedule search spaces its faults hundreds of milliseconds after
 * the writes, which is exactly right for exploring protocol states and almost
 * never lands inside the few milliseconds an optimization holds data in an
 * intermediate state (measured: 1 crash in 300 schedules hit an unflushed
 * group-commit buffer). This campaign aims its faults *into* those windows.
 *
 * Each run: a 3-node cluster under virtual time, one Raft profile, a burst of
 * concurrent writes, reads and CAS operations, and one scenario-specific fault
 * injected a seeded 0-30 ms into the burst:
 *
 *   crash-before-flush        crash a random node, usually inside its flush window
 *   crash-after-flush         crash just after the flush window, before acks return
 *   leader-crash-pipelined    crash the leader with replication in flight
 *   follower-crash-inflight   crash a follower with batches in flight to it
 *   partition-during-pipeline isolate a random node mid-burst, heal later
 *   leader-change-outstanding isolate the leader until a new one is elected, then
 *                             heal so its outstanding RPCs and replies land late
 *   cluster-power-loss        crash every node at once mid-burst (correlated failure)
 *   power-loss-on-ack         crash every node at the exact instant the first write
 *                             is acknowledged to its client
 *   power-loss-lone-write     one write with nothing else in flight, power lost the
 *                             instant it is acknowledged; with per-node disk delays
 *                             this is where a leader counting a volatile copy shows
 *
 * The last two exist because a single crash cannot expose an early
 * acknowledgement in a 3-node cluster: the other copies still get flushed.
 * Losing an acknowledged write needs every counted copy to be volatile at
 * once, which is what a rack-wide power loss does.
 *
 * After the fault: recover, keep writing, settle, then *crash and restart every
 * node* so the final state comes only from durable storage. Checked:
 *
 *   linearizability            of the full client history (writes, reads, CAS)
 *   log matching / committed prefix  on the live replicas
 *   durability of acknowledged writes  every write the client saw committed is
 *                              in the committed log of every node after the
 *                              full restart, at the index it was committed at
 *
 * `coverage` in each result counts whether the targeted window was hit: entries
 * lost from an unflushed buffer, acknowledgements still held for durability,
 * and replication RPCs outstanding at the moment of the fault.
 *
 *   node sim/perf-faults.js --profile group-commit-delay --runs 50
 */

const { SimCluster } = require('./cluster');
const { Rng } = require('./simulator');
const { LinearizabilityChecker, HistoryRecorder, registerModel } = require('./linearizability');
const { profileOptions } = require('../replica/raft-profiles');
const { wireFor } = require('./wire-codec');

const SCENARIOS = [
    'crash-before-flush',
    'crash-after-flush',
    'leader-crash-pipelined',
    'follower-crash-inflight',
    'partition-during-pipeline',
    'leader-change-outstanding',
    'cluster-power-loss',
    'power-loss-on-ack',
    'power-loss-lone-write',
];

function flushWindowMs(options) {
    return options.groupCommit ? options.groupCommit.maxDelayMs : 0;
}

function snapshotCoverage(cluster, index) {
    const node = cluster.nodes.get(cluster.urls[index]);
    const store = cluster.stores[index].log;
    let outstanding = 0;
    if (node) {
        outstanding += node._replicating ? node._replicating.size : 0;
        if (node._progress) {
            for (const progress of Object.values(node._progress)) outstanding += progress.inflight.size;
        }
    }
    return {
        unflushedEntries: store.pending.length,
        heldAcks: node && node._durableWaiters ? node._durableWaiters.length : 0,
        outstandingRpcs: outstanding,
    };
}

/**
 * Heterogeneous disks: when the profile groups commits behind a delay, each
 * node gets its own seeded delay in [0, 2 x maxDelayMs]. With identical delays
 * the leader always flushes before a follower's durable acknowledgement can
 * return, so a leader that wrongly counted its volatile copy would never be
 * caught; a slow leader disk makes that window real.
 */
function perNodeOptions(raftOptions, seed) {
    if (!raftOptions.groupCommit || raftOptions.groupCommit.maxDelayMs === 0) return raftOptions;
    const diskRng = new Rng((seed * 40503 + 7) >>> 0);
    const delays = [0, 1, 2].map(() => diskRng.int(2 * raftOptions.groupCommit.maxDelayMs + 1));
    return (index) => ({
        ...raftOptions,
        groupCommit: { ...raftOptions.groupCommit, maxDelayMs: delays[index] ?? raftOptions.groupCommit.maxDelayMs },
    });
}

async function runPerfFault({ seed, scenario, profile, writes = 24 }) {
    const raftOptions = profileOptions(profile);
    const cluster = new SimCluster({
        size: 3,
        seed,
        dropRate: 0,
        minLatency: 1,
        maxLatency: 12,
        raftOptions: perNodeOptions(raftOptions, seed),
        wrapTransport: wireFor(raftOptions),
    });
    const rng = new Rng((seed * 2654435761 + SCENARIOS.indexOf(scenario) * 97 + 13) >>> 0);
    const history = new HistoryRecorder(cluster.clock);
    const checker = new LinearizabilityChecker(registerModel, { maxSteps: 400000 });
    const acknowledged = []; // { index, term, data }
    const inFlight = new Set();
    const coverage = { unflushedEntries: 0, heldAcks: 0, outstandingRpcs: 0, faultTarget: null };
    let process = 0;

    const leader0 = await cluster.awaitLeader(6000);
    if (!leader0) {
        cluster.stop();
        return { ok: false, seed, scenario, profile, failure: 'no initial leader' };
    }

    const issue = (op) => {
        const id = ++process;
        history.invoke(id, op);
        inFlight.add(id);
        const done = (type, value) => {
            if (!inFlight.has(id)) return;
            inFlight.delete(id);
            if (type === 'ok') history.ok(id, value);
            else if (type === 'info') history.info(id);
            else history.fail(id);
        };
        const current = cluster.leader;
        if (!current) { done('fail'); return; }
        if (op.kind === 'read') {
            current.node.readLinearizable((sm) => sm.get(op.key)).then(
                (record) => done('ok', record ? record.value : null),
                () => done('fail'),
            );
            return;
        }
        const command = op.kind === 'cas'
            ? { op: 'cas', key: op.key, expectRev: 0, value: op.value }
            : { op: 'set', key: op.key, value: op.value };
        current.node.clientAppend(command).then((outcome) => {
            if (!outcome.committed) { done('info'); return; }
            acknowledged.push({ index: outcome.entry.index, term: outcome.entry.term, data: outcome.entry.data });
            done('ok', op.kind === 'cas' ? Boolean(outcome.result && outcome.result.ok) : true);
            // The client has its answer; the lights go out in the same instant.
            if ((scenario === 'power-loss-on-ack' || scenario === 'power-loss-lone-write') && faulted === null) powerLoss();
        }).catch(() => done('fail'));
    };

    const keys = ['x', 'y', 'z'];
    const randomOp = (i) => {
        const key = keys[rng.int(keys.length)];
        const roll = rng.float();
        if (roll < 0.6) return { kind: 'write', key, value: `v${seed}-${i}` };
        if (roll < 0.85) return { kind: 'read', key };
        return { kind: 'cas', key, expected: null, value: `c${seed}-${i}` };
    };

    // The burst: writes spread over ~12 ms so batching, pipelining and the
    // flush window all have something in them when the fault lands.
    const faultAt = scenario === 'crash-after-flush'
        ? flushWindowMs(raftOptions) + 1 + rng.int(6)
        : rng.int(Math.max(2, Math.min(30, 2 * flushWindowMs(raftOptions) + 12)));
    let faulted = null;
    const powerLoss = () => {
        let lost = 0;
        let held = 0;
        for (let i = 0; i < 3; i += 1) {
            lost += cluster.stores[i].log.pending.length;
            const node = cluster.nodes.get(cluster.urls[i]);
            held += node && node._durableWaiters ? node._durableWaiters.length : 0;
        }
        coverage.unflushedEntries = lost;
        coverage.heldAcks = held;
        coverage.faultTarget = 'all';
        for (let i = 0; i < 3; i += 1) if (cluster.nodes.has(cluster.urls[i])) cluster.crash(i);
        faulted = { kind: 'power-loss' };
    };
    const injectFault = () => {
        const leader = cluster.leader;
        const leaderIndex = leader ? cluster.urls.indexOf(leader.url) : 0;
        const followers = [0, 1, 2].filter((i) => i !== leaderIndex);
        let target;
        switch (scenario) {
            case 'crash-before-flush':
            case 'crash-after-flush':
                target = rng.int(3);
                Object.assign(coverage, snapshotCoverage(cluster, target), { faultTarget: target });
                cluster.crash(target);
                faulted = { kind: 'crash', target };
                break;
            case 'leader-crash-pipelined':
                target = leaderIndex;
                Object.assign(coverage, snapshotCoverage(cluster, target), { faultTarget: target });
                cluster.crash(target);
                faulted = { kind: 'crash', target };
                break;
            case 'follower-crash-inflight':
                target = followers[rng.int(followers.length)];
                Object.assign(coverage, snapshotCoverage(cluster, leaderIndex), { faultTarget: target });
                coverage.unflushedEntries = cluster.stores[target].log.pending.length;
                cluster.crash(target);
                faulted = { kind: 'crash', target };
                break;
            case 'partition-during-pipeline':
                target = rng.int(3);
                Object.assign(coverage, snapshotCoverage(cluster, leaderIndex), { faultTarget: target });
                cluster.isolate(target);
                faulted = { kind: 'isolate', target };
                break;
            case 'leader-change-outstanding':
                target = leaderIndex;
                Object.assign(coverage, snapshotCoverage(cluster, leaderIndex), { faultTarget: target });
                cluster.isolate(target);
                faulted = { kind: 'isolate-leader', target };
                break;
            case 'cluster-power-loss':
                powerLoss();
                break;
            case 'power-loss-on-ack':
            case 'power-loss-lone-write':
                // Triggered from the acknowledgement itself (see issue()); if no
                // write was acknowledged in time, fall back to now.
                powerLoss();
                break;
            default:
                throw new Error(`unknown scenario ${scenario}`);
        }
    };

    let elapsed = 0;
    if (scenario === 'power-loss-lone-write') {
        issue({ kind: 'write', key: 'x', value: `lone-${seed}` });
        for (let waited = 0; waited < 200 && faulted === null; waited += 1) await cluster.tick(1);
        if (faulted === null) injectFault();
    }
    for (let i = 0; i < (scenario === 'power-loss-lone-write' ? 0 : writes); i += 1) {
        if (faulted === null && elapsed >= faultAt) injectFault();
        issue(randomOp(i));
        const gap = rng.int(2); // 0-1 ms: several operations share a turn
        if (gap > 0) { await cluster.tick(gap); elapsed += gap; }
    }
    if (faulted === null) {
        await cluster.tick(Math.max(0, faultAt - elapsed));
        injectFault();
    }

    // Leave the fault in place long enough to matter, then recover.
    if (scenario === 'leader-change-outstanding') {
        // Long enough for the majority side to elect a new leader.
        await cluster.tick(900);
    } else {
        await cluster.tick(40 + rng.int(200));
    }
    for (let i = 0; i < 8; i += 1) { issue(randomOp(writes + i)); await cluster.tick(rng.int(20)); }
    cluster.heal();
    if (faulted.kind === 'crash') cluster.restart(faulted.target);
    if (faulted.kind === 'power-loss') for (let i = 0; i < 3; i += 1) cluster.restart(i);
    await cluster.tick(1500);
    for (let i = 0; i < 6; i += 1) { issue(randomOp(writes + 8 + i)); await cluster.tick(5 + rng.int(20)); }
    await cluster.tick(3000);
    for (const id of [...inFlight]) { history.info(id); inFlight.delete(id); }

    const failures = [];
    const linear = checker.check(history.events);
    if (!linear.linearizable && !linear.exhausted) failures.push(`history:non-linearizable ${linear.reason || ''}`.trim());
    const logs = cluster.checkLogConsistency();
    if (!logs.ok) failures.push(`invariant:log-matching ${logs.reason}`);
    const prefix = cluster.checkCommittedPrefix();
    if (!prefix.ok) failures.push(`invariant:state-machine-safety ${prefix.reason}`);

    // Full-cluster crash: whatever survives now survives only on "disk".
    for (let i = 0; i < 3; i += 1) if (cluster.nodes.has(cluster.urls[i])) cluster.crash(i);
    for (let i = 0; i < 3; i += 1) cluster.restart(i);
    const recovered = await cluster.awaitLeader(8000);
    await cluster.tick(2000);
    if (!recovered) {
        failures.push('liveness:no-leader-after-full-restart');
    } else {
        for (const ack of acknowledged) {
            for (const [url, node] of cluster.nodes) {
                const entry = node.log[ack.index];
                if (!entry || entry.term !== ack.term || JSON.stringify(entry.data) !== JSON.stringify(ack.data)) {
                    failures.push(`durability:acknowledged-write-lost index=${ack.index} on ${url}`);
                    break;
                }
                if (node.commitIndex < ack.index) {
                    failures.push(`durability:acknowledged-write-not-committed index=${ack.index} on ${url}`);
                    break;
                }
            }
        }
    }
    const summary = history.summary();
    cluster.stop();
    return {
        ok: failures.length === 0,
        seed,
        scenario,
        profile,
        faultAtMs: faultAt,
        fault: faulted,
        coverage,
        acknowledgedWrites: acknowledged.length,
        operations: summary,
        failures,
    };
}

async function campaign({ profile, runs = 20, first = 1, scenarios = SCENARIOS }) {
    const results = [];
    const log = console.log;
    console.log = () => {};
    try {
        for (const scenario of scenarios) {
            for (let seed = first; seed < first + runs; seed += 1) {
                results.push(await runPerfFault({ seed, scenario, profile }));
            }
        }
    } finally {
        console.log = log;
    }
    const byScenario = {};
    for (const r of results) {
        const s = byScenario[r.scenario] || (byScenario[r.scenario] = {
            runs: 0, failures: 0, acknowledgedWrites: 0,
            hitUnflushed: 0, hitHeldAcks: 0, hitOutstandingRpcs: 0,
        });
        s.runs += 1;
        if (!r.ok) s.failures += 1;
        s.acknowledgedWrites += r.acknowledgedWrites;
        if (r.coverage.unflushedEntries > 0) s.hitUnflushed += 1;
        if (r.coverage.heldAcks > 0) s.hitHeldAcks += 1;
        if (r.coverage.outstandingRpcs > 0) s.hitOutstandingRpcs += 1;
    }
    return { profile, runs: results.length, failures: results.filter((r) => !r.ok), byScenario };
}

async function main() {
    const argv = process.argv.slice(2);
    const options = { profile: 'baseline', runs: 20, first: 1 };
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i].replace(/^--/, '');
        const value = argv[++i];
        options[key] = key === 'profile' ? value : Number(value);
    }
    const outcome = await campaign(options);
    for (const [scenario, s] of Object.entries(outcome.byScenario)) {
        process.stdout.write(`${scenario.padEnd(28)} runs=${s.runs} failures=${s.failures} acked=${s.acknowledgedWrites} `
            + `hit: unflushed=${s.hitUnflushed} heldAcks=${s.hitHeldAcks} outstandingRpcs=${s.hitOutstandingRpcs}\n`);
    }
    for (const failure of outcome.failures.slice(0, 10)) {
        process.stdout.write(`FAIL seed=${failure.seed} ${failure.scenario}: ${failure.failures.join('; ')}\n`);
    }
    process.stdout.write(`profile=${outcome.profile} runs=${outcome.runs} failures=${outcome.failures.length}\n`);
    if (outcome.failures.length > 0) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = { runPerfFault, campaign, SCENARIOS };
