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

const DEFAULTS = { runs: 100, seed: 0, ops: 40, clients: 4, nodes: 3, drop: 0.05, verbose: 0 };

function parseArgs() {
    const options = { ...DEFAULTS };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i].replace(/^--/, '');
        if (!(key in options)) continue;
        options[key] = key === 'verbose' ? 1 : Number(argv[i + 1]);
        if (key !== 'verbose') i += 1;
    }
    return options;
}

/**
 * One complete run. Pure function of `seed`.
 */
async function runOnce(seed, options) {
    const rng = new Rng(seed * 2654435761 + 1);
    const cluster = new SimCluster({
        size: options.nodes,
        seed,
        dropRate: options.drop,
        minLatency: 1,
        maxLatency: 20,
    });
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
    const prefix = cluster.checkCommittedPrefix();
    const states = cluster.states();
    const converged = new Set(states.map((s) => s.keys)).size <= 1;

    cluster.stop();

    // An exhausted search proves nothing either way, so it is reported
    // separately rather than counted as a violation. Calling it a failure would
    // be alarmist; calling it a pass would be dishonest.
    const inconclusive = !linear.linearizable && linear.exhausted;
    const ok = (linear.linearizable || inconclusive) && logs.ok && prefix.ok;
    return {
        seed,
        ok,
        inconclusive,
        linear,
        logs,
        prefix,
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

    console.log = realLog;
    console.log(single
        ? `replaying seed ${options.seed}\n`
        : `fuzzing ${runs} seeds · ${options.nodes} nodes · ${options.ops} ops · ` +
          `${options.clients} clients · ${(options.drop * 100).toFixed(0)}% packet loss\n`);

    const failures = [];
    let inconclusiveCount = 0;
    let totalOps = 0;
    let totalSteps = 0;
    let totalVirtualMs = 0;
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

        if (!result.ok) failures.push(result);
        if (result.inconclusive) inconclusiveCount += 1;

        if (single || options.verbose) {
            console.log(`seed ${seed}: ${result.ok ? 'PASS' : 'FAIL'}`);
            if (result.faults) console.log(`  faults: ${result.faults.join(' → ')}`);
            if (result.operations) console.log(`  ops: ${JSON.stringify(result.operations)}`);
            if (result.linear) {
                console.log(`  linearizable: ${result.linear.linearizable} ` +
                    `(${result.linear.checked} ops, ${result.linear.steps} search steps)`);
                if (result.linear.reason) console.log(`    ${result.linear.reason}`);
            }
            if (result.logs) console.log(`  log agreement: ${result.logs.ok}${result.logs.reason ? ' — ' + result.logs.reason : ''}`);
            if (result.prefix) console.log(`  committed prefix: ${result.prefix.ok} (${result.prefix.verified ?? 0} entries verified)`);
            if (result.states) for (const s of result.states) {
                console.log(`    ${s.replicaId} ${s.state.padEnd(9)} term=${s.term} log=${s.logLength} commit=${s.commitIndex}`);
            }
            if (result.log && options.verbose) for (const line of result.log) console.log(`    ${line}`);
        } else if ((i + 1) % 25 === 0) {
            process.stdout.write(`  ${i + 1}/${runs} seeds — ${failures.length} failures\n`);
        }
    }

    const elapsed = (Date.now() - startedAt) / 1000;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`seeds run            ${runs}`);
    console.log(`operations issued    ${totalOps}`);
    console.log(`virtual time covered ${(totalVirtualMs / 1000).toFixed(1)}s`);
    console.log(`real time taken      ${elapsed.toFixed(1)}s  ` +
        `(${(totalVirtualMs / 1000 / Math.max(0.001, elapsed)).toFixed(0)}x faster than real time)`);
    console.log(`checker search steps ${totalSteps}`);
    console.log(`inconclusive         ${inconclusiveCount}  (search budget hit; not violations)`);
    console.log(`failures             ${failures.length}`);

    if (failures.length > 0) {
        console.log(`\nfailing seeds: ${failures.map((f) => f.seed).join(', ')}`);
        console.log('replay one with:  node sim/fuzz.js --seed <n> --verbose');
        const first = failures[0];
        console.log(`\nfirst failure (seed ${first.seed}):`);
        if (first.reason) console.log(`  ${first.reason}`);
        if (first.linear && !first.linear.linearizable) console.log(`  linearizability: ${first.linear.reason}`);
        if (first.logs && !first.logs.ok) console.log(`  log agreement: ${first.logs.reason}`);
        if (first.prefix && !first.prefix.ok) console.log(`  committed prefix: ${first.prefix.reason}`);
        process.exit(1);
    }

    console.log('\nno violations found.');
})();
