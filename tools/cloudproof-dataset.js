#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
    evaluateAcceptanceGates,
    evaluateResearchCorpus,
    generateResearchCorpus,
} = require('../sim/cloud-corpus');

function parseArgs(argv = process.argv.slice(2)) {
    const options = {
        simulations: 10000,
        seedStart: 20000,
        outputDirectory: path.join('artifacts', 'cloudproof', 'research-dataset'),
        iterations: 100,
        concurrency: 16,
        budgets: [100, 500, 1000, 5000],
        minimumSimulations: 10000,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const value = argv[++index];
        if (value === undefined) throw new TypeError(`missing value for ${token}`);
        if (token === '--simulations') options.simulations = Number(value);
        else if (token === '--seed') options.seedStart = Number(value);
        else if (token === '--out') options.outputDirectory = value;
        else if (token === '--iterations') options.iterations = Number(value);
        else if (token === '--concurrency') options.concurrency = Number(value);
        else if (token === '--minimum-simulations') options.minimumSimulations = Number(value);
        else if (token === '--budgets') options.budgets = value.split(',').map(Number);
        else throw new TypeError(`unknown option: ${token}`);
    }
    return options;
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const corpus = await generateResearchCorpus(options);
    const evaluation = evaluateResearchCorpus(corpus, options);
    const acceptance = evaluateAcceptanceGates(corpus, evaluation, options);
    const report = { manifest: corpus.manifest, evaluation, acceptance };
    const output = path.resolve(options.outputDirectory);
    fs.writeFileSync(path.join(output, 'evaluation.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({
        output,
        simulations: corpus.manifest.simulations,
        transitions: corpus.manifest.transitions,
        balance: corpus.manifest.balance,
        acceptance,
    }, null, 2)}\n`);
    if (!acceptance.passed) process.exitCode = 1;
    return report;
}

if (require.main === module) void main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});

module.exports = { main, parseArgs };
