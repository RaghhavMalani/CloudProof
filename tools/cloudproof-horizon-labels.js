#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCloudSchedule } = require('../sim/cloud-runtime');

function parseArgs(argv = process.argv.slice(2)) {
    const options = {
        dataset: path.join('artifacts', 'cloudproof', 'research-dataset'),
        out: path.join('artifacts', 'cloudproof', 'audit', 'horizon-labels.jsonl'),
        horizons: [1, 3, 5, 10, 20],
        splits: ['validation', 'test', 'ood'],
        concurrency: 16,
        maxSchedules: null,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const name = argv[index];
        const value = argv[index + 1];
        if (value === undefined) throw new TypeError(`missing value for ${name}`);
        if (name === '--dataset') options.dataset = value;
        else if (name === '--out') options.out = value;
        else if (name === '--horizons') options.horizons = value.split(',').map(Number);
        else if (name === '--splits') options.splits = value.split(',').filter(Boolean);
        else if (name === '--concurrency') options.concurrency = Number(value);
        else if (name === '--max-schedules') options.maxSchedules = Number(value);
        else throw new TypeError(`unknown option: ${name}`);
        index += 1;
    }
    if (!options.horizons.every((value) => Number.isInteger(value) && value > 0)) {
        throw new TypeError('horizons must be positive integers');
    }
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 128) {
        throw new TypeError('concurrency must be an integer in [1, 128]');
    }
    return options;
}

function readJsonLines(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function transitionIdentity(row) {
    return JSON.stringify({ state: row.state, action: row.action, nextState: row.nextState });
}

async function labelSchedule(item, horizons) {
    const byHorizon = new Map();
    for (const horizon of horizons) {
        const result = await runCloudSchedule(item.schedule, {
            mutant: item.schedule.runtime,
            horizonTransitions: horizon,
        });
        byHorizon.set(horizon, result.graphTransitions);
    }
    const reference = byHorizon.get(horizons[0]);
    for (const rows of byHorizon.values()) {
        assert.equal(rows.length, reference.length);
        for (let index = 0; index < rows.length; index += 1) {
            assert.equal(transitionIdentity(rows[index]), transitionIdentity(reference[index]));
        }
    }
    return reference.map((row, index) => ({
        recordId: `${item.scenarioId}:transition-${row.sequence}`,
        scenarioId: item.scenarioId,
        split: item.split,
        labels: Object.fromEntries(horizons.map((horizon) => [String(horizon), Boolean(
            byHorizon.get(horizon)[index].labels.sloViolationWithinKTransitions,
        )])),
    }));
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    let schedules = readJsonLines(path.join(options.dataset, 'schedules.jsonl'))
        .filter((item) => options.splits.includes(item.split));
    if (options.maxSchedules !== null) schedules = schedules.slice(0, options.maxSchedules);
    const rows = [];
    for (let start = 0; start < schedules.length; start += options.concurrency) {
        const batch = schedules.slice(start, start + options.concurrency);
        const completed = await Promise.all(batch.map((item) => labelSchedule(item, options.horizons)));
        completed.forEach((items) => rows.push(...items));
    }
    const output = path.resolve(options.out);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    const result = { output, schedules: schedules.length, transitions: rows.length, horizons: options.horizons };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
}

if (require.main === module) void main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});

module.exports = { labelSchedule, main, parseArgs, transitionIdentity };
