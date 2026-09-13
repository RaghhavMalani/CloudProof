#!/usr/bin/env node
'use strict';

const {
    benchmarkCloudProof,
    replayCloudArtifact,
    searchCloudSchedules,
} = require('../sim/cloud-search');

function parse(argv) {
    const options = { runs: 100, seed: 1337, scenario: 'flagship', mutant: 'correct', artifacts: true };
    let command = 'search';
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (['search', 'benchmark', 'replay'].includes(token)) { command = token; continue; }
        if (token === '--no-shrink') { options.shrink = false; continue; }
        if (token === '--no-artifacts') { options.artifacts = false; continue; }
        const key = token.replace(/^--/, '');
        const value = argv[++index];
        if (value === undefined) throw new TypeError(`missing value for ${token}`);
        if (['runs', 'seed', 'noise', 'maxEvaluations'].includes(key)) options[key] = Number(value);
        else options[key] = value;
    }
    return { command, options };
}

function print(outcome) {
    if (!outcome.found) {
        process.stdout.write(`NO CLOUD SAFETY VIOLATION (${outcome.runs} schedules)\n`);
        return;
    }
    const result = outcome.minimized;
    process.stdout.write([
        'CLOUDPROOF',
        '',
        'CLOUD SAFETY VIOLATION',
        '',
        `Invariant: ${result.failure.invariant}`,
        `Expected: ${result.failure.expected}`,
        `Observed: ${result.failure.observed}`,
        `Failure class: ${result.failure.violationClass}`,
        `Original: ${outcome.original.schedule.actions.length} actions / ${outcome.original.graphTransitions.length} transitions`,
        `Minimized: ${result.schedule.actions.length} actions / ${result.graphTransitions.length} transitions`,
        '',
        'Counterexample:',
        ...result.schedule.actions.map((action, index) => `${index + 1}. ${action.type}`),
        '',
        `Replay digest: ${result.replayFingerprint}`,
        outcome.file ? `Artifact: ${outcome.file}` : null,
        outcome.datasetFile ? `Dataset: ${outcome.datasetFile}` : null,
    ].filter((line) => line !== null).join('\n') + '\n');
}

async function main(argv = process.argv.slice(2)) {
    const { command, options } = parse(argv);
    if (command === 'benchmark') {
        const result = await benchmarkCloudProof(options);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (result.mutantKillRate.killed !== result.mutantKillRate.total
            || result.correctedModel.violations !== 0) process.exitCode = 1;
        return result;
    }
    if (command === 'replay') {
        const file = options.file || options.replay;
        if (!file) throw new TypeError('replay requires --file <artifact>');
        const result = await replayCloudArtifact(file);
        process.stdout.write(result.sameFailure && result.byteIdentical
            ? `REPRODUCED BYTE-IDENTICALLY: ${result.result.failure.violationClass}\n`
            : 'REPLAY MISMATCH\n');
        process.exitCode = result.sameFailure && result.byteIdentical ? 0 : 1;
        return result;
    }
    const result = await searchCloudSchedules(options);
    print(result);
    return result;
}

if (require.main === module) void main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});

module.exports = { main, parse };
