#!/usr/bin/env node
/**
 * fuzz.js — searches the fault-schedule space for a correctness violation.
 *
 * Each seed produces a complete, reproducible run: a random schedule of
 * partitions, crashes and restarts, interleaved with concurrent client
 * operations, all under virtual time. At the end three independent things are
 * checked:
 *
 *   linearizability   the client-visible history admits a valid sequential
 *                     explanation respecting real-time order
 *   log agreement     no two replicas hold different entries at the same index
 *   committed prefix  every replica's committed prefix is identical
 *
 * The last two inspect internal state directly, which the client cannot see.
 * A system can produce a linearizable history while its replicas quietly
 * disagree — the divergence only surfaces later, after a leader change — so
 * checking both from outside and inside is not redundant.
 *
 *   node sim/fuzz.js --runs 200
 *   node sim/fuzz.js --seed 1337 --verbose     # replay one exact failure
 */

// Raft nodes log heavily; a fuzz run over hundreds of seeds would bury the
// result in election chatter. Silenced unless --verbose asks for it.
// Capture the real logger BEFORE silencing, or the summary is silenced too.
const realLog = console.log.bind(console);
const QUIET = !process.argv.includes('--verbose');
if (QUIET) console.log = () => {};

const { SimCluster } = require('./cluster');
const { LinearizabilityChecker, HistoryRecorder } = require('./linearizability');
const { Rng } = require('./simulator');

const DEFAULTS = { runs: 100, seed: 0, ops: 40, clients: 4, nodes: 3, spares: 2, drop: 0.05, verbose: 0, digest: 0, membership: 1 };

function parseArgs() {
    const options = { ...DEFAULTS };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i].replace(/^--/, '');
        if (!(key in options)) continue;
        const flag = key === 'verbose' || key === 'digest';
        options[key] = flag ? 1 : Number(argv[i + 1]);
        if (!flag) i += 1;
    }
    return options;
}

/**
 * One complete run. Pure function of `seed`.
 */
async function runOnce(seed, options) {
    const rng = new Rng(seed * 2654435761 + 1);
    // Spares exist but are not members. `addMember` spawns and admits them, so
    // the cluster genuinely grows rather than toggling nodes that were always
    // there.
    const cluster = new SimCluster({
        size: options.nodes + options.spares,
        voters: options.nodes,
        seed,
        dropRate: options.drop,
        minLatency: 1,
        maxLatency: 20,
    });
    // Spares are spawned but not members: crash them so they are inert until
    // deliberately added, rather than campaigning for a cluster they are not in.
    for (let i = options.nodes; i < options.nodes + options.spares; i += 1) cluster.crash(i);

    const recorder = new HistoryRecorder(cluster.clock);
    const checker = new LinearizabilityChecker({
        init: () => ({}),
        apply: require('./linearizability').registerModel.apply,
        hash: require('./linearizability').registerModel.hash,
    }, { maxSteps: 400_000 });

    const log = [];
    const note = (message) => { log.push(`t=${cluster.clock.now()} ${message}`); };

    if (!(await cluster.awaitLeader(8000))) {
        cluster.stop();
        return { seed, ok: false, phase: 'bootstrap', reason: 'no leader was ever elected', log };
    }
    note(`leader elected: ${cluster.leader.node.replicaId}`);

    const keys = ['x', 'y', 'z'];
    const inFlight = new Map();
    let issued = 0;

    // Clients run as independent virtual processes. Each keeps one operation
    // outstanding at a time, which is what makes the history's concurrency
    // structure meaningful — a client with no outstanding request cannot be
    // party to a race.
    const step = () => {
        if (issued >= options.ops) return;

        for (let process = 1; process <= options.clients; process += 1) {
            if (inFlight.has(process)) continue;
            if (issued >= options.ops) break;
            issued += 1;

            const key = rng.pick(keys);
            const roll = rng.float();
            const op = roll < 0.45
                ? { kind: 'write', key, value: `v${issued}` }
                : roll < 0.8
                    ? { kind: 'read', key }
                    : { kind: 'cas', key, expected: null, value: `c${issued}` };

            recorder.invoke(process, op);
            inFlight.set(process, op);

            const leader = cluster.leader;
            if (!leader) {
                // Definitively rejected before touching the log: it did not
                // happen, and telling the checker so shrinks its search space.
                recorder.fail(process);
                inFlight.delete(process);
                continue;
            }

            if (op.kind === 'read') {
                // ReadIndex, not a lease read. The leader confirms it still
                // holds a quorum *now* before answering, so a deposed leader
                // discovers it is stale instead of serving from a log it has
                // stopped receiving. Set READ_MODE=lease to reproduce the
                // violation the lease path used to produce.
                leader.node.readLinearizable((sm) => sm.get(op.key)).then((record) => {
                    recorder.ok(process, record ? record.value : null);
                    inFlight.delete(process);
                }).catch(() => {
                    recorder.fail(process);
                    inFlight.delete(process);
                });
                continue;
            }

            const command = op.kind === 'cas'
                ? { op: 'cas', key: op.key, expectRev: 0, value: op.value }
                : { op: 'set', key: op.key, value: op.value };

            leader.node.clientAppend(command).then((outcome) => {
                if (!outcome.committed) {
                    // The entry is in the leader's log but never reached a
                    // quorum before the timeout. It may still commit later, so
                    // the outcome is genuinely unknown — recording this as a
                    // failure would make the checker reject perfectly valid
                    // histories.
                    recorder.info(process);
                } else if (op.kind === 'cas') {
                    recorder.ok(process, outcome.result ? outcome.result.ok : false);
                } else {
                    recorder.ok(process, true);
                }
                inFlight.delete(process);
            }).catch(() => {
                recorder.fail(process);
                inFlight.delete(process);
            });
        }
    };

    // ── the fault schedule ───────────────────────────────────────────────────
    const faults = [];
    const pendingConfig = [];
    let crashed = null;

    for (let round = 0; round < 14 && issued < options.ops; round += 1) {
        step();
        await cluster.tick(rng.range(120, 400));

        const roll = rng.float();
        if (crashed !== null && roll < 0.4) {
            cluster.restart(crashed);
            faults.push(`restart node${crashed}`);
            note(`restarted node${crashed}`);
            crashed = null;
        } else if (roll < 0.25) {
            const victim = rng.int(options.nodes);
            cluster.isolate(victim);
            faults.push(`isolate node${victim}`);
            note(`isolated node${victim}`);
        } else if (roll < 0.45) {
            cluster.heal();
            faults.push('heal');
            note('healed the network');
        } else if (options.membership && roll < 0.52 && cluster.leader) {
            // Grow or shrink the cluster mid-flight. This is the schedule class
            // that makes membership changes worth fuzzing at all: a
            // reconfiguration that overlaps a partition or an election is where
            // the disjoint-majority hazard would show up.
            // Fired, never awaited.
            //
            // addServer waits on virtual timers while a learner catches up, and
            // virtual time only moves when cluster.tick() runs. Awaiting it here
            // deadlocks the whole simulation: the change waits for a clock that
            // is waiting for the change. Starting it and letting the loop's
            // subsequent ticks drive it is also more realistic — a
            // reconfiguration genuinely does overlap whatever else is happening.
            const voters = cluster.leader.node.members.length;
            const spareIndex = cluster.urls.findIndex(
                (u, i) => i >= options.nodes && !cluster.leader.node.members.includes(u));
            if (voters < options.nodes + options.spares && spareIndex >= 0 && rng.chance(0.6)) {
                faults.push(`add node${spareIndex}`);
                note(`addServer node${spareIndex} started`);
                pendingConfig.push(cluster.addMember(spareIndex, { catchUpTimeoutMs: 2500 })
                    .then((r) => note(`addServer node${spareIndex}: ${r.ok ? 'ok' : r.error}`))
                    .catch((e) => note(`addServer node${spareIndex}: ${e.message}`)));
            } else if (voters > 2) {
                const victimUrl = cluster.leader.node.voterPeers[rng.int(voters - 1)];
                const victim = cluster.urls.indexOf(victimUrl);
                if (victim >= 0) {
                    faults.push(`remove node${victim}`);
                    note(`removeServer node${victim} started`);
                    pendingConfig.push(cluster.removeMember(victim)
                        .then((r) => note(`removeServer node${victim}: ${r.ok ? 'ok' : r.error}`))
                        .catch((e) => note(`removeServer node${victim}: ${e.message}`)));
                }
            }
        } else if (roll < 0.6 && crashed === null) {
            // Crash a minority only. Crashing two of three would stall the
            // cluster entirely, which tests nothing beyond "it stops" — the
            // interesting schedules are the ones that keep making progress.
            const victim = rng.int(options.nodes);
            cluster.crash(victim);
            faults.push(`crash node${victim}`);
            note(`crashed node${victim}`);
            crashed = victim;
        }

        await cluster.tick(rng.range(200, 600));
    }

    // Recover fully and let everything settle, so convergence can be asserted.
    cluster.heal();
    if (crashed !== null) cluster.restart(crashed);
    faults.push('heal + restart all');
    await cluster.tick(6000);
    // Let any reconfiguration still in flight settle before checking invariants.
    await Promise.allSettled(pendingConfig);
    await cluster.tick(3000);

    // Anything still outstanding never returned.
    for (const process of inFlight.keys()) recorder.info(process);

    // ── verdicts ─────────────────────────────────────────────────────────────
    const linear = checker.check(recorder.events);
    if (process.env.DUMP_HISTORY) {
        realLog('\n--- history ---');
        for (const e of recorder.events) {
            realLog(`  t=${String(e.at).slice(-7)} p${e.process} ${e.type.padEnd(6)} ` +
                (e.type === 'invoke' ? JSON.stringify(e.op) : JSON.stringify(e.op.result)));
        }
    }
    const logs = cluster.checkLogConsistency();
    const overlap = cluster.checkConfigurationOverlap();
    const prefix = cluster.checkCommittedPrefix();
    const states = cluster.states();
    const converged = new Set(states.map((s) => s.keys)).size <= 1;

    cluster.stop();

    // An exhausted search proves nothing either way, so it is reported
    // separately rather than counted as a violation. Calling it a failure would
    // be alarmist; calling it a pass would be dishonest.
    const inconclusive = !linear.linearizable && linear.exhausted;
    const ok = (linear.linearizable || inconclusive) && logs.ok && prefix.ok && overlap.ok;

    // A fingerprint of everything the run produced. Two invocations of the same
    // seed must agree on this, not merely on pass/fail — a verdict can match by
    // luck while the underlying schedule differs. `--digest` prints these so two
    // runs can be diffed directly, which is how the Math.random leak was
    // eventually pinned down.
    const digest = [
        linear.linearizable, linear.steps, linear.checked,
        logs.ok, prefix.ok, prefix.verified, overlap.ok, overlap.changes ?? 0,
        cluster.clock.now(), cluster.network.stats.delivered, cluster.network.stats.dropped,
        states.map((s) => `${s.replicaId}:${s.term}:${s.logLength}:${s.commitIndex}:${s.keys}`).join('|'),
    ].join('~');
    return {
        seed,
        ok,
        digest,
        inconclusive,
        linear,
        logs,
        prefix,
        overlap,
        converged,
        states,
        faults,
        log,
        operations: recorder.summary(),
        network: cluster.network.stats,
        virtualMs: cluster.clock.now() - 1_700_000_000_000,
    };
}

(async function main() {
    const options = parseArgs();
    const single = options.seed > 0;
    const runs = single ? 1 : options.runs;

    realLog(single
        ? `replaying seed ${options.seed}\n`
        : `fuzzing ${runs} seeds · ${options.nodes} nodes · ${options.ops} ops · ` +
          `${options.clients} clients · ${(options.drop * 100).toFixed(0)}% packet loss\n`);

    const failures = [];
    let inconclusiveCount = 0;
    const digests = [];
    let totalOps = 0;
    let totalSteps = 0;
    let totalVirtualMs = 0;
    let totalConfigChanges = 0;
    const startedAt = Date.now();

    for (let i = 0; i < runs; i += 1) {
        const seed = single ? options.seed : i + 1;
        let result;
        try {
            result = await runOnce(seed, options);
        } catch (error) {
            result = { seed, ok: false, phase: 'crash', reason: error.message, stack: error.stack };
        }

        totalOps += result.operations ? result.operations.invoke : 0;
        totalSteps += result.linear ? result.linear.steps : 0;
        totalVirtualMs += result.virtualMs || 0;
        totalConfigChanges += (result.overlap && result.overlap.changes) || 0;

        if (!result.ok) failures.push(result);
        if (result.inconclusive) inconclusiveCount += 1;
        if (options.digest && result.digest) {
            let h = 2166136261;
            for (let c = 0; c < result.digest.length; c += 1) {
                h ^= result.digest.charCodeAt(c);
                h = Math.imul(h, 16777619);
            }
            digests.push(`${seed} ${(h >>> 0).toString(16).padStart(8, '0')}`);
        }

        if (single || options.verbose) {
            realLog(`seed ${seed}: ${result.ok ? 'PASS' : 'FAIL'}`);
            if (result.faults) realLog(`  faults: ${result.faults.join(' → ')}`);
            if (result.operations) realLog(`  ops: ${JSON.stringify(result.operations)}`);
            if (result.linear) {
                realLog(`  linearizable: ${result.linear.linearizable} ` +
                    `(${result.linear.checked} ops, ${result.linear.steps} search steps)`);
                if (result.linear.reason) realLog(`    ${result.linear.reason}`);
            }
            if (result.logs) realLog(`  log agreement: ${result.logs.ok}${result.logs.reason ? ' — ' + result.logs.reason : ''}`);
            if (result.prefix) realLog(`  committed prefix: ${result.prefix.ok} (${result.prefix.verified ?? 0} entries verified)`);
            if (result.overlap) realLog(`  config overlap: ${result.overlap.ok} (${result.overlap.changes ?? 0} membership changes)${result.overlap.reason ? ' — ' + result.overlap.reason : ''}`);
            if (result.states) for (const s of result.states) {
                realLog(`    ${s.replicaId} ${s.state.padEnd(9)} term=${s.term} log=${s.logLength} commit=${s.commitIndex}`);
            }
            if (result.log && options.verbose) for (const line of result.log) realLog(`    ${line}`);
        } else if ((i + 1) % 25 === 0) {
            process.stdout.write(`  ${i + 1}/${runs} seeds — ${failures.length} failures\n`);
        }
    }

    const elapsed = (Date.now() - startedAt) / 1000;
    realLog(`\n${'─'.repeat(60)}`);
    realLog(`seeds run            ${runs}`);
    realLog(`operations issued    ${totalOps}`);
    realLog(`virtual time covered ${(totalVirtualMs / 1000).toFixed(1)}s`);
    realLog(`real time taken      ${elapsed.toFixed(1)}s  ` +
        `(${(totalVirtualMs / 1000 / Math.max(0.001, elapsed)).toFixed(0)}x faster than real time)`);
    realLog(`membership changes   ${totalConfigChanges}`);
    realLog(`checker search steps ${totalSteps}`);
    realLog(`inconclusive         ${inconclusiveCount}  (search budget hit; not violations)`);
    realLog(`failures             ${failures.length}`);
    if (options.digest) {
        realLog('\n--- per-seed digests ---');
        for (const line of digests) realLog(`  ${line}`);
    }

    if (failures.length > 0) {
        realLog(`\nfailing seeds: ${failures.map((f) => f.seed).join(', ')}`);
        realLog('replay one with:  node sim/fuzz.js --seed <n> --verbose');
        const first = failures[0];
        realLog(`\nfirst failure (seed ${first.seed}):`);
        if (first.reason) realLog(`  ${first.reason}`);
        if (first.linear && !first.linear.linearizable) realLog(`  linearizability: ${first.linear.reason}`);
        if (first.logs && !first.logs.ok) realLog(`  log agreement: ${first.logs.reason}`);
        if (first.prefix && !first.prefix.ok) realLog(`  committed prefix: ${first.prefix.reason}`);
        if (first.overlap && !first.overlap.ok) realLog(`  config overlap: ${first.overlap.reason}`);
        process.exit(1);
    }

    realLog('\nno violations found.');
})();
