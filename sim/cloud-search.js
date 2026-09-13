#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sameCloudFailure } = require('../packages/cloudproof/invariants');
const {
    RiskBaseline,
    evaluateRiskBaseline,
    exportTransitionDataset,
} = require('../packages/cloudproof/transition-dataset');
const { getCloudMutant, CLOUD_MUTANTS } = require('./cloud-mutants');
const { runCloudSchedule } = require('./cloud-runtime');
const { CloudCoverageTracker, materializeCloudSchedule } = require('./cloud-schedule');
const { CloudScheduleShrinker } = require('./cloud-shrinker');

const output = console.log.bind(console);

const CLI_DEFAULTS = Object.freeze({
    runs: 100,
    seed: 1337,
    scenario: 'flagship',
    strategy: 'coverage',
    mutant: 'correct',
    shrink: true,
    artifacts: true,
    maxEvaluations: 500,
    noise: 12,
    out: null,
    replay: null,
    benchmark: false,
});

function parseArgs(argv = process.argv.slice(2)) {
    const options = { ...CLI_DEFAULTS };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--no-shrink') options.shrink = false;
        else if (argument === '--no-artifacts') options.artifacts = false;
        else if (argument === '--benchmark') options.benchmark = true;
        else if (argument.startsWith('--')) {
            const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            const value = argv[++index];
            if (value === undefined) throw new TypeError(`missing value for ${argument}`);
            if (['runs', 'seed', 'noise', 'maxEvaluations'].includes(key)) options[key] = Number(value);
            else if (['scenario', 'strategy', 'mutant', 'out', 'replay'].includes(key)) options[key] = value;
            else throw new TypeError(`unknown option: ${argument}`);
        }
    }
    if (!Number.isInteger(options.runs) || options.runs < 1) throw new TypeError('runs must be positive');
    if (!Number.isInteger(options.seed)) throw new TypeError('seed must be an integer');
    getCloudMutant(options.mutant);
    return options;
}

function artifactPath(seed, requested = null) {
    return path.resolve(requested || path.join('artifacts', 'cloudproof', `failure-${seed}.json`));
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return file;
}

function resultSummary(result) {
    return {
        ok: result.ok,
        failure: result.failure,
        replayFingerprint: result.replayFingerprint,
        mutant: result.mutant,
        metrics: result.metrics,
    };
}

function describeAction(action) {
    const details = [];
    if (action.version) details.push(action.version);
    if (action.nodeId) details.push(action.nodeId);
    if (action.zoneId) details.push(action.zoneId);
    if (action.cpuPercent) details.push(`CPU=${action.cpuPercent}%`);
    if (action.replicas !== undefined) details.push(`replicas=${action.replicas}`);
    if (action.ms !== undefined) details.push(`${action.ms}ms`);
    return `${action.type}${details.length ? ` (${details.join(', ')})` : ''}`;
}

async function searchCloudSchedules(input = {}) {
    const settings = { ...CLI_DEFAULTS, artifacts: false, ...input };
    const coverage = new CloudCoverageTracker();
    let found = null;
    for (let offset = 0; offset < settings.runs; offset += 1) {
        const seed = settings.seed + offset;
        const scenario = settings.mutant === 'correct' ? settings.scenario : 'mutant';
        const schedule = materializeCloudSchedule(seed, {
            scenario,
            runtime: settings.mutant,
            strategy: settings.strategy,
            coverageHint: settings.strategy === 'coverage' && offset > 0 ? coverage.nextHint() : null,
            riskScorer: settings.riskScorer || null,
            noise: settings.noise,
        });
        const result = await runCloudSchedule(schedule, { mutant: settings.mutant });
        coverage.observe(result);
        if (!result.ok) {
            found = { seed, foundAfter: offset + 1, original: result };
            break;
        }
    }
    if (!found) return { found: false, runs: settings.runs, coverage: coverage.export(), settings };

    let minimized = { schedule: found.original.schedule, result: found.original, stats: null, passes: null };
    if (settings.shrink) {
        minimized = await new CloudScheduleShrinker({
            mutant: settings.mutant,
            maxEvaluations: settings.maxEvaluations,
        }).shrink(found.original.schedule, found.original);
    }
    const replay = await runCloudSchedule(minimized.schedule, { mutant: settings.mutant });
    if (!sameCloudFailure(found.original, replay)) throw new Error('cloud replay changed the exact fingerprint');
    if (replay.replayFingerprint !== minimized.result.replayFingerprint) {
        throw new Error('cloud schedule did not replay byte-identically');
    }

    const artifact = {
        schemaVersion: 1,
        kind: 'cloudproof.counterexample',
        scenario: found.original.schedule.scenario,
        mutant: settings.mutant,
        seed: found.seed,
        foundAfter: found.foundAfter,
        expectedFailure: replay.failure,
        replayFingerprint: replay.replayFingerprint,
        schedule: replay.schedule,
        original: {
            actions: found.original.schedule.actions.length,
            transitions: found.original.graphTransitions.length,
        },
        minimized: {
            actions: replay.schedule.actions.length,
            transitions: replay.graphTransitions.length,
        },
        shrink: minimized.stats ? { stats: minimized.stats, passes: minimized.passes } : null,
        result: resultSummary(replay),
        trace: replay.trace,
    };
    let file = null;
    let datasetFile = null;
    if (settings.artifacts) {
        file = writeJson(artifactPath(found.seed, settings.out), artifact);
        datasetFile = exportTransitionDataset(
            replay.graphTransitions,
            path.join(path.dirname(file), 'datasets', `transitions-seed-${found.seed}.jsonl`),
        );
        artifact.dataset = path.relative(path.dirname(file), datasetFile).split(path.sep).join('/');
        writeJson(file, artifact);
    }
    return {
        found: true,
        foundAfter: found.foundAfter,
        original: found.original,
        minimized: replay,
        shrink: minimized.stats,
        coverage: coverage.export(),
        artifact,
        file,
        datasetFile,
        settings,
    };
}

async function replayCloudArtifact(file) {
    const artifact = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const result = await runCloudSchedule(artifact.schedule, { mutant: artifact.mutant });
    return {
        artifact,
        result,
        sameFailure: sameCloudFailure(artifact.expectedFailure, result),
        byteIdentical: artifact.replayFingerprint === result.replayFingerprint,
    };
}

async function safeCampaign({ seed = 5000, runs = 1000 } = {}) {
    let violations = 0;
    let transitions = 0;
    const records = [];
    for (let offset = 0; offset < runs; offset += 1) {
        const schedule = materializeCloudSchedule(seed + offset, {
            scenario: 'safe', runtime: 'correct', strategy: 'random', noise: offset % 4,
        });
        const result = await runCloudSchedule(schedule, { mutant: 'correct' });
        if (!result.ok) violations += 1;
        transitions += result.graphTransitions.length;
        if (offset < 20) records.push(...result.graphTransitions);
    }
    return { schedules: runs, violations, transitions, records };
}

async function benchmarkCloudProof(input = {}) {
    const settings = { ...CLI_DEFAULTS, ...input, artifacts: false };
    const mutants = [];
    for (const mutant of CLOUD_MUTANTS) {
        const outcome = await searchCloudSchedules({
            ...settings,
            mutant: mutant.id,
            scenario: 'mutant',
            runs: Math.max(1, Math.min(10, settings.runs)),
            artifacts: false,
        });
        mutants.push({
            mutant: mutant.id,
            killed: outcome.found && outcome.minimized.failure.violationClass === mutant.expectedViolationClass,
            expectedViolationClass: mutant.expectedViolationClass,
            observedViolationClass: outcome.minimized?.failure?.violationClass || null,
            originalActions: outcome.original?.schedule.actions.length || null,
            minimizedActions: outcome.minimized?.schedule.actions.length || null,
            byteIdenticalReplay: outcome.found
                ? outcome.minimized.replayFingerprint === (await runCloudSchedule(
                    outcome.minimized.schedule, { mutant: mutant.id },
                )).replayFingerprint
                : false,
        });
    }
    const flagship = await searchCloudSchedules({
        ...settings, mutant: 'correct', scenario: 'flagship', runs: 1, artifacts: false,
    });
    const correct = await safeCampaign({ seed: settings.seed + 10000, runs: Math.max(1000, settings.runs) });
    const records = [...correct.records, ...(flagship.minimized?.graphTransitions || [])];
    const split = Math.max(1, Math.floor(records.length * 0.7));
    const model = new RiskBaseline().train(records.slice(0, split));
    const evaluationRecords = records.slice(split).length ? records.slice(split) : records;
    const baseline = evaluateRiskBaseline(model, evaluationRecords, { randomSeed: settings.seed });
    const killed = mutants.filter((mutant) => mutant.killed).length;
    return {
        mutantKillRate: { killed, total: mutants.length, ratio: killed / mutants.length },
        mutants,
        correctedModel: {
            schedules: correct.schedules,
            violations: correct.violations,
            transitions: correct.transitions,
        },
        flagship: {
            found: flagship.found,
            failureClass: flagship.minimized?.failure?.violationClass || null,
            originalActions: flagship.original?.schedule.actions.length || null,
            minimizedActions: flagship.minimized?.schedule.actions.length || null,
            exactFingerprint: flagship.found
                ? sameCloudFailure(flagship.original, flagship.minimized)
                : false,
        },
        riskBaseline: { model: model.export(), evaluation: baseline },
    };
}

function printCounterexample(outcome) {
    const result = outcome.minimized;
    output('CLOUDPROOF');
    output('');
    output('CLOUD SAFETY VIOLATION');
    output('');
    output(`Invariant: ${result.failure.invariant}`);
    output(`Expected: ${result.failure.expected}`);
    output(`Observed: ${result.failure.observed}`);
    output(`Failure class: ${result.failure.violationClass}`);
    output(`Original: ${outcome.original.schedule.actions.length} actions / ${outcome.original.graphTransitions.length} transitions`);
    output(`Minimized: ${result.schedule.actions.length} actions / ${result.graphTransitions.length} transitions`);
    output('');
    output('Counterexample:');
    result.schedule.actions.forEach((action, index) => output(`${index + 1}. ${describeAction(action)}`));
    output(`Replay digest: ${result.replayFingerprint}`);
    if (outcome.file) {
        output(`Artifact: ${outcome.file}`);
        output(`Dataset: ${outcome.datasetFile}`);
    }
}

async function main() {
    const options = parseArgs();
    if (options.replay) {
        const replay = await replayCloudArtifact(options.replay);
        output(replay.sameFailure && replay.byteIdentical
            ? `REPRODUCED BYTE-IDENTICALLY: ${replay.result.failure.violationClass}`
            : 'REPLAY MISMATCH');
        process.exitCode = replay.sameFailure && replay.byteIdentical ? 0 : 1;
        return;
    }
    if (options.benchmark) {
        const benchmark = await benchmarkCloudProof(options);
        output(JSON.stringify(benchmark, null, 2));
        if (benchmark.mutantKillRate.killed !== benchmark.mutantKillRate.total
            || benchmark.correctedModel.violations !== 0
            || !benchmark.flagship.found
            || benchmark.flagship.minimizedActions >= 10) process.exitCode = 1;
        return;
    }
    const outcome = await searchCloudSchedules(options);
    if (outcome.found) printCounterexample(outcome);
    else output(`NO CLOUD SAFETY VIOLATION (${outcome.runs} schedules)`);
    const expected = getCloudMutant(options.mutant).expectedViolationClass;
    if ((expected && (!outcome.found || outcome.minimized.failure.violationClass !== expected))
        || (!expected && options.scenario === 'safe' && outcome.found)) process.exitCode = 1;
}

if (require.main === module) void main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});

module.exports = {
    CLI_DEFAULTS,
    benchmarkCloudProof,
    describeAction,
    parseArgs,
    replayCloudArtifact,
    safeCampaign,
    searchCloudSchedules,
};
