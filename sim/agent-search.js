#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sameFailure } = require('../packages/simulator/agent-invariants');
const { AGENT_ACTION, AGENT_FAULT } = require('./agent-actions');
const { MUTANTS, getMutant } = require('./agent-mutants');
const { runAgentSchedule } = require('./agent-runtime-sim');
const { AgentCoverageTracker, materializeAgentSchedule } = require('./agent-schedule');
const { AgentScheduleShrinker } = require('./agent-shrinker');

const output = console.log.bind(console);

const CLI_DEFAULTS = Object.freeze({
    workflow: 'refund',
    runs: 10000,
    seed: 1337,
    strategy: 'coverage',
    mutant: 'correct',
    shrink: true,
    maxEvaluations: 500,
    noise: 5,
    out: null,
    replay: null,
    benchmark: false,
    verbose: false,
    artifacts: true,
});

function parseArgs(argv = process.argv.slice(2)) {
    const options = { ...CLI_DEFAULTS };
    const strings = new Set(['workflow', 'strategy', 'mutant', 'out', 'replay']);
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--no-shrink') { options.shrink = false; continue; }
        if (token === '--benchmark') { options.benchmark = true; continue; }
        if (token === '--verbose') { options.verbose = true; continue; }
        const key = token.replace(/^--/, '');
        if (!Object.hasOwn(options, key)) continue;
        const value = argv[++index];
        options[key] = strings.has(key) ? value : Number(value);
    }
    if (!['random', 'coverage'].includes(options.strategy)) {
        throw new TypeError('strategy must be random or coverage');
    }
    if (!Number.isInteger(options.runs) || options.runs < 1) throw new TypeError('runs must be a positive integer');
    if (!Number.isInteger(options.seed)) throw new TypeError('seed must be an integer');
    getMutant(options.mutant);
    return options;
}

function artifactPath(workflow, seed, requested = null) {
    return requested || path.join('artifacts', 'failures', `${workflow}-${seed}.json`);
}

function resultSummary(result) {
    return {
        ok: result.ok,
        failure: result.failure,
        checks: result.checks,
        finalState: result.finalState,
        replayFingerprint: result.replayFingerprint,
        metrics: result.metrics,
        mutant: result.mutant,
    };
}

function writeJson(file, value) {
    const resolved = path.resolve(file);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return resolved;
}

function regressionTestSource({ artifactName, runtimeModule, invariantModule }) {
    return [
        "'use strict';",
        '',
        "const assert = require('node:assert/strict');",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const test = require('node:test');",
        `const { runAgentSchedule } = require(${JSON.stringify(runtimeModule)});`,
        `const { sameFailure } = require(${JSON.stringify(invariantModule)});`,
        '',
        "test('regression: autonomous agent counterexample', () => {",
        `    const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, ${JSON.stringify(artifactName)}), 'utf8'));`,
        '    const result = runAgentSchedule(artifact.schedule, { mutant: artifact.mutant });',
        "    assert.equal(result.ok, false, 'the captured mutant must still violate safety');",
        "    assert.ok(sameFailure(artifact.expectedFailure, result), 'the exact failure fingerprint changed');",
        '    assert.equal(result.replayFingerprint, artifact.replayFingerprint);',
        '});',
        '',
    ].join('\n');
}

function writeRegressionTest(artifactFile) {
    const resolvedArtifact = path.resolve(artifactFile);
    const directory = path.dirname(resolvedArtifact);
    const relative = (target) => {
        let value = path.relative(directory, target).split(path.sep).join('/');
        if (!value.startsWith('.')) value = `./${value}`;
        return value;
    };
    const testFile = resolvedArtifact.replace(/\.json$/i, '') + '.test.js';
    const source = regressionTestSource({
        artifactName: path.basename(resolvedArtifact),
        runtimeModule: relative(path.resolve(__dirname, 'agent-runtime-sim')),
        invariantModule: relative(path.resolve(__dirname, '..', 'packages', 'simulator', 'agent-invariants')),
    });
    fs.writeFileSync(testFile, source, 'utf8');
    return testFile;
}

function describeAction(action) {
    const descriptions = {
        [AGENT_ACTION.ADVANCE]: `advance execution (${action.workerId || 'worker-1'})`,
        [AGENT_ACTION.AUTHORIZE_EFFECT]: `authorize ${action.effectKey || 'refund'} effect`,
        [AGENT_ACTION.DISPATCH_EFFECT]: `dispatch ${action.effectKey || 'refund'} effect`,
        [AGENT_ACTION.RECONCILE_EFFECT]: `reconcile ${action.effectKey || 'refund'} effect`,
        [AGENT_ACTION.RECORD_RESULT]: `record ${action.effectKey || 'refund'} result`,
        [AGENT_ACTION.COMMIT_EFFECT]: `commit ${action.effectKey || 'refund'} effect`,
        [AGENT_ACTION.APPROVE_SNAPSHOT]: 'approve semantic snapshot transition',
        [AGENT_FAULT.CRASH_WORKER]: 'crash and recover worker',
        [AGENT_FAULT.CRASH_LEADER]: 'crash leader and fail over',
        [AGENT_FAULT.DROP_TOOL_RESPONSE]: 'drop tool response after provider commit',
        [AGENT_FAULT.DELAY_TOOL_RESPONSE]: 'delay tool response',
        [AGENT_FAULT.START_RACING_WORKER]: 'start racing worker',
        [AGENT_FAULT.DEPLOY_POLICY]: 'deploy new policy snapshot',
        [AGENT_FAULT.LOSE_QUORUM]: 'lose Raft quorum',
        [AGENT_FAULT.RESTORE_QUORUM]: 'restore Raft quorum',
    };
    return descriptions[action.type] || action.type;
}

function createArtifact({ settings, seed, foundAfter, original, shrink, replay }) {
    return {
        schemaVersion: 1,
        kind: 'miniraft.agent-failure-artifact',
        createdAt: new Date().toISOString(),
        workflow: settings.workflow,
        mutant: settings.mutant,
        strategy: settings.strategy,
        search: { initialSeed: settings.seed, failingSeed: seed, foundAfter },
        expectedFailure: replay.failure,
        replayFingerprint: replay.replayFingerprint,
        schedule: replay.schedule,
        original: {
            actions: original.schedule.actions.length,
            events: original.trace.events.length,
            replayFingerprint: original.replayFingerprint,
        },
        minimized: {
            actions: replay.schedule.actions.length,
            events: replay.trace.events.length,
        },
        shrink: shrink ? { stats: shrink.stats, passes: shrink.passes } : null,
        result: resultSummary(replay),
        trace: replay.trace,
    };
}

async function searchAgentSchedules(options = {}) {
    const settings = { ...CLI_DEFAULTS, artifacts: false, ...options };
    const coverage = new AgentCoverageTracker();
    const startedAt = Date.now();
    let found = null;
    let evaluated = 0;

    for (let offset = 0; offset < settings.runs; offset += 1) {
        const seed = settings.seed + offset;
        const coverageHint = settings.strategy === 'coverage' ? coverage.nextHint() : null;
        const schedule = materializeAgentSchedule(seed, {
            workflow: settings.workflow,
            runtime: settings.mutant,
            strategy: settings.strategy,
            coverageHint,
            noise: settings.noise,
        });
        const result = runAgentSchedule(schedule, { mutant: settings.mutant });
        evaluated += 1;
        coverage.observe(result);
        if (settings.verbose) {
            output(`seed ${seed}: ${result.ok ? 'PASS' : result.failure.violationClass}`
                + ` (${schedule.actions.length} actions / ${result.trace.events.length} events)`);
        }
        if (result.ok) continue;
        found = { seed, foundAfter: evaluated, original: result, schedule };
        break;
    }

    if (!found) {
        return {
            found: false,
            runs: evaluated,
            elapsedMs: Date.now() - startedAt,
            coverage: coverage.export(),
            settings,
        };
    }

    let shrink = null;
    let minimized = found.original;
    if (settings.shrink) {
        const shrinker = new AgentScheduleShrinker({
            mutant: settings.mutant,
            maxEvaluations: settings.maxEvaluations,
            onProgress: settings.verbose ? (progress) => {
                output(`  shrink ${progress.pass}: ${progress.actions} actions / ${progress.events} events`);
            } : null,
        });
        shrink = await shrinker.shrink(found.schedule, found.original);
        minimized = shrink.result;
    }
    const replay = runAgentSchedule(minimized.schedule, { mutant: settings.mutant });
    if (!sameFailure(found.original, replay)) throw new Error('minimized replay changed the failure fingerprint');
    if (replay.replayFingerprint !== minimized.replayFingerprint) {
        throw new Error('materialized agent schedule did not replay byte-identically');
    }

    const artifact = createArtifact({
        settings,
        seed: found.seed,
        foundAfter: found.foundAfter,
        original: found.original,
        shrink,
        replay,
    });
    let file = null;
    let regressionFile = null;
    if (settings.artifacts) {
        file = writeJson(artifactPath(settings.workflow, found.seed, settings.out), artifact);
        regressionFile = writeRegressionTest(file);
        artifact.regressionTest = path.basename(regressionFile);
        writeJson(file, artifact);
    }
    return {
        found: true,
        seed: found.seed,
        foundAfter: found.foundAfter,
        runs: evaluated,
        elapsedMs: Date.now() - startedAt,
        coverage: coverage.export(),
        original: found.original,
        minimized: replay,
        shrink,
        artifact,
        file,
        regressionFile,
        settings,
    };
}

async function replayArtifact(file) {
    const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = runAgentSchedule(artifact.schedule, { mutant: artifact.mutant || artifact.schedule.runtime });
    return {
        artifact,
        result,
        sameFailure: sameFailure(artifact.expectedFailure, result),
        byteIdentical: artifact.replayFingerprint === result.replayFingerprint,
    };
}

async function benchmarkAgentSearch(options = {}) {
    const settings = { ...CLI_DEFAULTS, artifacts: false, ...options };
    const rows = [];
    for (const strategy of ['random', 'coverage']) {
        for (const mutant of MUTANTS) {
            const outcome = await searchAgentSchedules({
                ...settings,
                strategy,
                mutant: mutant.id,
                artifacts: false,
            });
            rows.push({
                strategy,
                mutant: mutant.id,
                expectedViolationClass: mutant.expectedViolationClass,
                found: outcome.found,
                correctlyClassified: outcome.found
                    && outcome.minimized.failure.violationClass === mutant.expectedViolationClass,
                schedulesToFirstFailure: outcome.foundAfter || null,
                wallClockMs: outcome.elapsedMs,
                originalActions: outcome.original?.schedule.actions.length || null,
                minimizedActions: outcome.minimized?.schedule.actions.length || null,
                originalEvents: outcome.original?.trace.events.length || null,
                minimizedEvents: outcome.minimized?.trace.events.length || null,
                shrinkEvaluations: outcome.shrink?.stats.evaluations || 0,
                actionCoverage: outcome.coverage.target,
                transitionCoverage: outcome.coverage.transitions.length,
            });
        }
    }

    const correct = await searchAgentSchedules({
        ...settings,
        mutant: 'correct',
        strategy: 'coverage',
        shrink: false,
        artifacts: false,
    });
    const killed = rows.filter((row) => row.strategy === 'coverage' && row.correctlyClassified).length;
    return {
        rows,
        mutantKillRate: { killed, total: MUTANTS.length, ratio: killed / MUTANTS.length },
        correctRuntime: {
            runs: correct.runs,
            violations: correct.found ? 1 : 0,
            coverage: correct.coverage,
        },
    };
}

function printCounterexample(outcome) {
    const result = outcome.minimized;
    output('');
    output('AGENT SAFETY VIOLATION');
    output('');
    output(`Invariant: ${result.failure.invariant}`);
    output(`Failure class: ${result.failure.violationClass}`);
    output(`Found after: ${outcome.foundAfter} schedules`);
    output(`Original: ${outcome.original.schedule.actions.length} actions / ${outcome.original.trace.events.length} events`);
    output(`Minimized: ${result.schedule.actions.length} actions / ${result.trace.events.length} events`);
    output('');
    output('Counterexample:');
    result.schedule.actions.forEach((action, index) => output(`${index + 1}. ${describeAction(action)}`));
    if (outcome.file) {
        output('');
        output(`Artifact: ${outcome.file}`);
        output(`Regression: ${outcome.regressionFile}`);
        output(`Replay: node sim/agent-search.js --replay ${outcome.file}`);
    }
}

async function main() {
    const options = parseArgs();
    if (options.replay) {
        const replay = await replayArtifact(options.replay);
        if (replay.sameFailure && replay.byteIdentical) {
            output(`REPRODUCED BYTE-IDENTICALLY: ${replay.result.failure.violationClass}`);
            return;
        }
        output('REPLAY MISMATCH');
        process.exitCode = 1;
        return;
    }
    if (options.benchmark) {
        const benchmark = await benchmarkAgentSearch(options);
        output(JSON.stringify(benchmark, null, 2));
        if (benchmark.mutantKillRate.killed !== benchmark.mutantKillRate.total
            || benchmark.correctRuntime.violations !== 0) process.exitCode = 1;
        return;
    }

    output(`searching ${options.runs} ${options.strategy} schedules for ${options.workflow}`
        + ` against ${options.mutant}`);
    const outcome = await searchAgentSchedules({ ...options, artifacts: true });
    if (outcome.found) printCounterexample(outcome);
    else output(`NO AGENT SAFETY VIOLATION (${outcome.runs} schedules, `
        + `${outcome.coverage.target.covered}/${outcome.coverage.target.total} action/fault coverage)`);

    const expected = getMutant(options.mutant).expectedViolationClass;
    if (expected && (!outcome.found || outcome.minimized.failure.violationClass !== expected)) process.exitCode = 1;
    if (!expected && outcome.found) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    CLI_DEFAULTS,
    artifactPath,
    benchmarkAgentSearch,
    describeAction,
    parseArgs,
    regressionTestSource,
    replayArtifact,
    resultSummary,
    searchAgentSchedules,
    writeRegressionTest,
};
