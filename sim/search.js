#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { materializeSchedule, runSchedule, DEFAULTS } = require('./schedule');
const { ScheduleShrinker } = require('./shrinker');
const { explainFailure } = require('../packages/simulator/explain');
const { CoverageTracker } = require('../packages/simulator/coverage');

const output = console.log.bind(console);

async function runWithoutProtocolChatter(task, quiet = true) {
    if (!quiet) return task();
    const logger = console.log;
    console.log = () => {};
    try {
        return await task();
    } finally {
        console.log = logger;
    }
}

const CLI_DEFAULTS = {
    runs: 100,
    seed: 0,
    ops: DEFAULTS.ops,
    clients: DEFAULTS.clients,
    nodes: DEFAULTS.nodes,
    spares: DEFAULTS.spares,
    drop: DEFAULTS.drop,
    membership: 1,
    shrink: true,
    maxEvaluations: 250,
    out: null,
    replay: null,
    verbose: false,
};

function parseArgs(argv = process.argv.slice(2)) {
    const options = { ...CLI_DEFAULTS };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--no-shrink') { options.shrink = false; continue; }
        if (token === '--verbose') { options.verbose = true; continue; }
        const key = token.replace(/^--/, '');
        if (!Object.hasOwn(options, key)) continue;
        const value = argv[++index];
        if (['out', 'replay'].includes(key)) options[key] = value;
        else options[key] = Number(value);
    }
    return options;
}

function resultSummary(result) {
    return {
        ok: result.ok,
        failure: result.failure,
        linear: result.linear,
        logs: result.logs,
        prefix: result.prefix,
        overlap: result.overlap,
        rollout: result.rollout,
        states: result.states,
        network: result.network,
        operations: result.operations,
        virtualMs: result.virtualMs,
        decisionDiagnostics: result.decisionDiagnostics,
    };
}

function artifactPath(seed, requested, multiple) {
    if (!requested) return path.join('artifacts', 'failures', 'seed-' + seed + '.json');
    if (!multiple) return requested;
    const parsed = path.parse(requested);
    return path.join(parsed.dir, parsed.name + '-seed-' + seed + (parsed.ext || '.json'));
}

function writeArtifact(file, artifact) {
    const resolved = path.resolve(file);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
    return resolved;
}

function regressionTestSource({ artifactName, scheduleModule, signature }) {
    return [
        "'use strict';",
        '',
        "const assert = require('node:assert/strict');",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const test = require('node:test');",
        'const { runSchedule } = require(' + JSON.stringify(scheduleModule) + ');',
        '',
        "test('regression: " + signature.replace(/'/g, '') + "', async () => {",
        '    const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '
            + JSON.stringify(artifactName) + "), 'utf8'));",
        '    const result = await runSchedule(artifact.schedule, { recording: false });',
        '    assert.equal(result.failure && result.failure.signature, ' + JSON.stringify(signature) + ');',
        '});',
        '',
    ].join('\n');
}

function writeRegressionTest(artifactFile, signature) {
    const resolvedArtifact = path.resolve(artifactFile);
    const directory = path.dirname(resolvedArtifact);
    const testFile = resolvedArtifact.replace(/\.json$/i, '') + '.test.js';
    let scheduleModule = path.relative(directory, path.resolve(__dirname, 'schedule')).split(path.sep).join('/');
    if (!scheduleModule.startsWith('.')) scheduleModule = './' + scheduleModule;
    const source = regressionTestSource({
        artifactName: path.basename(resolvedArtifact), scheduleModule, signature,
    });
    fs.writeFileSync(testFile, source, 'utf8');
    return testFile;
}

async function replayArtifact(file) {
    const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
    const schedule = artifact.schedule || artifact;
    const result = await runWithoutProtocolChatter(() => runSchedule(schedule, { recording: true }));
    return { artifact, result, explanation: explainFailure(result) };
}

async function search(options = {}) {
    const settings = { ...CLI_DEFAULTS, ...options };
    const firstSeed = settings.seed > 0 ? settings.seed : 1;
    const runs = settings.seed > 0 ? 1 : settings.runs;
    const failures = [];
    const coverage = new CoverageTracker();
    const startedAt = Date.now();

    for (let offset = 0; offset < runs; offset += 1) {
        const seed = firstSeed + offset;
        const schedule = materializeSchedule(seed, {
            ops: settings.ops,
            clients: settings.clients,
            nodes: settings.nodes,
            spares: settings.spares,
            drop: settings.drop,
            membership: Boolean(settings.membership),
            coverageHint: coverage.nextHint(),
        });
        const result = await runWithoutProtocolChatter(
            () => runSchedule(schedule, { recording: true }), !settings.verbose,
        );
        if (settings.verbose || !result.ok) {
            output('seed ' + seed + ': ' + (result.ok ? 'PASS' : 'FAIL')
                + ' (' + schedule.actions.length + ' concrete actions, '
                + result.operations.invoke + ' operations)');
        }
        const coverageDelta = coverage.observe(result);
        if (settings.verbose && coverageDelta.added.length > 0) {
            output('  new coverage: ' + coverageDelta.added.join(', '));
        }

        if (result.ok) continue;

        let minimizedSchedule = result.schedule;
        let shrink = null;
        if (settings.shrink) {
            const shrinker = new ScheduleShrinker({
                maxEvaluations: settings.maxEvaluations,
                onProgress: settings.verbose
                    ? (progress) => output('  shrink ' + progress.pass + ': '
                        + progress.actions + ' actions after ' + progress.evaluations + ' evaluations')
                    : null,
            });
            shrink = await runWithoutProtocolChatter(
                () => shrinker.shrink(result.schedule, result), !settings.verbose,
            );
            minimizedSchedule = shrink.schedule;
        }

        const replay = await runWithoutProtocolChatter(
            () => runSchedule(minimizedSchedule, { recording: true }), !settings.verbose,
        );
        const explanation = explainFailure(replay);
        const artifact = {
            schemaVersion: 1,
            kind: 'miniraft.failure-artifact',
            createdAt: new Date().toISOString(),
            expectedFailure: result.failure,
            schedule: replay.schedule,
            result: resultSummary(replay),
            explanation,
            shrink: shrink ? { stats: shrink.stats, passes: shrink.passes } : null,
            trace: replay.trace,
        };
        const requestedFile = artifactPath(seed, settings.out, runs > 1);
        artifact.regressionTest = path.basename(requestedFile).replace(/\.json$/i, '') + '.test.js';
        const file = writeArtifact(
            requestedFile,
            artifact,
        );
        const regressionFile = writeRegressionTest(file, result.failure.signature);
        failures.push({ seed, file, regressionFile, artifact });
        output('  exact predicate: ' + result.failure.signature);
        output('  minimized: ' + schedule.actions.length + ' -> '
            + minimizedSchedule.actions.length + ' actions');
        output('  artifact: ' + file);
        output('  regression: ' + regressionFile);
        output('  explanation: ' + explanation.summary);
    }

    return {
        runs,
        failures,
        elapsedMs: Date.now() - startedAt,
        coverage: coverage.export(),
    };
}

async function main() {
    const options = parseArgs();
    if (options.replay) {
        const replay = await replayArtifact(options.replay);
        output(replay.result.ok ? 'PASS: failure no longer reproduces' : 'REPRODUCED: '
            + replay.result.failure.signature);
        output(replay.explanation.summary);
        process.exitCode = replay.result.ok ? 1 : 0;
        return;
    }

    output('searching ' + (options.seed > 0 ? 1 : options.runs)
        + ' materialized schedules with domain-separated decision tapes');
    const outcome = await search(options);
    output('searched ' + outcome.runs + ' schedules in '
        + (outcome.elapsedMs / 1000).toFixed(1) + 's; violations: ' + outcome.failures.length);
    if (outcome.failures.length > 0) process.exitCode = 1;
    output('target coverage: ' + outcome.coverage.target.covered + '/'
        + outcome.coverage.target.total);
    if (outcome.coverage.missing.length > 0) {
        output('coverage still missing: ' + outcome.coverage.missing.join(', '));
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = { parseArgs, search, replayArtifact, writeArtifact, writeRegressionTest,
    regressionTestSource, resultSummary };
