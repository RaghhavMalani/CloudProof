'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sameMultiAgentFailure } = require('../packages/simulator/multi-agent-invariants');
const { MULTI_AGENT_ACTION } = require('./multi-agent-actions');
const { MULTI_AGENT_MUTANTS, getMultiAgentMutant } = require('./multi-agent-mutants');
const { runMultiAgentSchedule } = require('./multi-agent-runtime-sim');
const { materializeMultiAgentSchedule, MultiAgentCoverageTracker } = require('./multi-agent-schedule');
const { MultiAgentScheduleShrinker } = require('./multi-agent-shrinker');

const output = console.log.bind(console);

const CLI_DEFAULTS = Object.freeze({
    runs: 100,
    seed: 1337,
    strategy: 'coverage',
    mutant: 'correct',
    shrink: true,
    artifacts: true,
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
            const value = argv[index + 1];
            if (value === undefined) throw new TypeError(`missing value for ${argument}`);
            index += 1;
            if (['runs', 'seed'].includes(key)) options[key] = Number(value);
            else if (['strategy', 'mutant', 'out', 'replay'].includes(key)) options[key] = value;
            else throw new TypeError(`unknown option: ${argument}`);
        }
    }
    if (!Number.isInteger(options.runs) || options.runs <= 0) throw new TypeError('runs must be positive');
    if (!Number.isInteger(options.seed)) throw new TypeError('seed must be an integer');
    getMultiAgentMutant(options.mutant);
    return options;
}

function resultSummary(result) {
    return {
        ok: result.ok,
        failure: result.failure,
        mutant: result.mutant,
        replayFingerprint: result.replayFingerprint,
        metrics: result.metrics,
    };
}

function artifactPath(mutant, seed, requested = null) {
    return path.resolve(requested || path.join(
        'artifacts', 'failures', `multi-agent-${mutant}-${seed}.json`,
    ));
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createArtifact({ settings, foundAfter, original, minimized, replay }) {
    return {
        schemaVersion: 1,
        kind: 'miniraft.multi-agent-counterexample',
        scenario: 'shared-order-financial-resolution',
        mutant: settings.mutant,
        strategy: settings.strategy,
        seed: original.schedule.seed,
        foundAfter,
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
            shrink: minimized.stats || null,
        },
        result: resultSummary(replay),
        trace: replay.trace,
    };
}

async function searchMultiAgentSchedules(input = {}) {
    const settings = { ...CLI_DEFAULTS, artifacts: false, ...input };
    const mutant = getMultiAgentMutant(settings.mutant);
    const coverage = new MultiAgentCoverageTracker();
    let found = null;
    for (let offset = 0; offset < settings.runs; offset += 1) {
        const seed = settings.seed + offset;
        const schedule = materializeMultiAgentSchedule(seed, {
            strategy: settings.strategy,
            runtime: settings.mutant,
            targetAgents: mutant.targetAgents,
        });
        const result = runMultiAgentSchedule(schedule, { mutant: settings.mutant });
        coverage.observe(result);
        if (!result.ok) {
            found = { seed, foundAfter: offset + 1, original: result };
            break;
        }
    }
    if (!found) {
        return {
            found: false,
            runs: settings.runs,
            mutant: settings.mutant,
            coverage: coverage.snapshot(),
        };
    }

    let minimized = {
        schedule: found.original.schedule,
        result: found.original,
        stats: null,
    };
    if (settings.shrink !== false) {
        minimized = new MultiAgentScheduleShrinker({ mutant: settings.mutant })
            .shrink(found.original.schedule, found.original);
    }
    const replay = runMultiAgentSchedule(minimized.schedule, { mutant: settings.mutant });
    if (!sameMultiAgentFailure(found.original, replay)) {
        throw new Error('minimized schedule changed the exact multi-agent failure fingerprint');
    }
    if (replay.replayFingerprint !== minimized.result.replayFingerprint) {
        throw new Error('minimized multi-agent schedule did not replay byte-identically');
    }

    let file = null;
    if (settings.artifacts) {
        file = artifactPath(settings.mutant, found.seed, settings.out);
        writeJson(file, createArtifact({
            settings,
            foundAfter: found.foundAfter,
            original: found.original,
            minimized,
            replay,
        }));
    }
    return {
        found: true,
        foundAfter: found.foundAfter,
        original: found.original,
        minimized: replay,
        shrink: minimized.stats,
        coverage: coverage.snapshot(),
        file,
    };
}

async function replayMultiAgentArtifact(file) {
    const artifact = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const result = runMultiAgentSchedule(artifact.schedule, { mutant: artifact.mutant });
    return {
        artifact,
        result,
        sameFailure: sameMultiAgentFailure(artifact.expectedFailure, result),
        byteIdentical: artifact.replayFingerprint === result.replayFingerprint,
    };
}

async function benchmarkMultiAgentRaces(input = {}) {
    const settings = { ...CLI_DEFAULTS, ...input, artifacts: false, shrink: true };
    const mutants = [];
    for (const mutant of MULTI_AGENT_MUTANTS) {
        const outcome = await searchMultiAgentSchedules({
            ...settings,
            mutant: mutant.id,
            strategy: 'coverage',
        });
        mutants.push({
            mutant: mutant.id,
            killed: outcome.found
                && outcome.minimized.failure.violationClass === mutant.expectedViolationClass,
            expectedViolationClass: mutant.expectedViolationClass,
            observedViolationClass: outcome.minimized?.failure?.violationClass || null,
            schedulesToFirstFailure: outcome.foundAfter || null,
            originalActions: outcome.original?.schedule.actions.length || null,
            minimizedActions: outcome.minimized?.schedule.actions.length || null,
            byteIdenticalReplay: outcome.found
                ? outcome.minimized.replayFingerprint
                    === runMultiAgentSchedule(outcome.minimized.schedule, { mutant: mutant.id }).replayFingerprint
                : false,
        });
    }

    const safeRuns = Math.max(1000, settings.runs * 10);
    let safeViolations = 0;
    let conflicts = 0;
    for (let offset = 0; offset < safeRuns; offset += 1) {
        const schedule = materializeMultiAgentSchedule(settings.seed + offset, {
            strategy: offset % 2 === 0 ? 'coverage' : 'random',
            runtime: 'correct',
        });
        const result = runMultiAgentSchedule(schedule, { mutant: 'correct' });
        if (!result.ok) safeViolations += 1;
        conflicts += result.metrics.conflicts;
    }
    const killed = mutants.filter((mutant) => mutant.killed).length;
    return {
        mutantKillRate: { killed, total: mutants.length, ratio: killed / mutants.length },
        mutants,
        correctedRuntime: { schedules: safeRuns, violations: safeViolations, resourceVersionConflicts: conflicts },
    };
}

function describeAction(action) {
    if (action.type === MULTI_AGENT_ACTION.YIELD) return 'scheduler yields';
    const verb = {
        [MULTI_AGENT_ACTION.READ]: 'reads order resource',
        [MULTI_AGENT_ACTION.DECIDE]: 'records locally valid decision',
        [MULTI_AGENT_ACTION.COMMIT]: 'attempts resource-backed effect authorization',
    }[action.type];
    return `${action.agentId} ${verb}`;
}

function printCounterexample(outcome) {
    const result = outcome.minimized;
    output('MULTI-AGENT SAFETY VIOLATION');
    output('');
    output(`Invariant: ${result.failure.invariant}`);
    if (result.failure.evidence.expected !== undefined) {
        output(`Expected: ${result.failure.evidence.expected}`);
        output(`Observed: ${result.failure.evidence.observed}`);
    }
    output(`Agents: ${(result.failure.evidence.agents || []).join(', ')}`);
    output(`Violation: ${result.failure.violationClass}`);
    output(`Original: ${outcome.original.schedule.actions.length} actions`);
    output(`Minimized: ${result.schedule.actions.length} actions`);
    output('');
    output('Interleaving:');
    result.schedule.actions.forEach((action, index) => output(`${index + 1}. ${describeAction(action)}`));
    const staleAuthorization = result.finalState.authorizations.find((authorization) => (
        authorization.expectedVersion !== authorization.actualVersion
    ));
    if (staleAuthorization) {
        output('');
        output('Cause: STALE_SHARED_RESOURCE_READ');
        output(`expected: ${staleAuthorization.resourceId}@${staleAuthorization.expectedVersion}`);
        output(`actual:   ${staleAuthorization.resourceId}@${staleAuthorization.actualVersion}`);
    }
    const conflict = result.finalState.conflicts[0];
    if (conflict) {
        output('');
        output('RESOURCE_VERSION_CONFLICT');
        output(`expected: ${conflict.resourceId}@${conflict.expectedVersion}`);
        output(`actual:   ${conflict.resourceId}@${conflict.actualVersion}`);
        output(`decision: ${conflict.decision}`);
    }
    if (outcome.file) output(`Replay: node sim/multi-agent-search.js --replay ${outcome.file}`);
}

async function main() {
    const options = parseArgs();
    if (options.replay) {
        const replay = await replayMultiAgentArtifact(options.replay);
        output(replay.sameFailure && replay.byteIdentical
            ? `REPRODUCED BYTE-IDENTICALLY: ${replay.result.failure.violationClass}`
            : 'REPLAY MISMATCH');
        process.exitCode = replay.sameFailure && replay.byteIdentical ? 0 : 1;
        return;
    }
    if (options.benchmark) {
        const benchmark = await benchmarkMultiAgentRaces(options);
        output(JSON.stringify(benchmark, null, 2));
        if (benchmark.mutantKillRate.killed !== benchmark.mutantKillRate.total
            || benchmark.correctedRuntime.violations !== 0) process.exitCode = 1;
        return;
    }

    const outcome = await searchMultiAgentSchedules(options);
    if (outcome.found) printCounterexample(outcome);
    else output(`NO MULTI-AGENT SAFETY VIOLATION (${outcome.runs} schedules)`);
    const expected = getMultiAgentMutant(options.mutant).expectedViolationClass;
    if ((expected && !outcome.found) || (!expected && outcome.found)) process.exitCode = 1;
}

if (require.main === module) void main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});

module.exports = {
    benchmarkMultiAgentRaces,
    parseArgs,
    replayMultiAgentArtifact,
    searchMultiAgentSchedules,
};
