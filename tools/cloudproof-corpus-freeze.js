#!/usr/bin/env node
'use strict';

// Writes a small, committable freeze record for a generated causal corpus:
// provenance, seeds, counts, gate verdicts, headline sanity numbers and the
// SHA-256 of every file. The corpus itself stays gitignored; the record is
// what later phases cite and what a regeneration is checked against.

const fs = require('node:fs');
const path = require('node:path');

function freezeRecord(directory) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    const evaluation = JSON.parse(fs.readFileSync(path.join(directory, 'evaluation.json'), 'utf8'));
    const probe = evaluation.evaluation.shortcutProbe;
    const horizon = String(evaluation.evaluation.defaultHorizon);
    const pairs = evaluation.evaluation.counterfactualPairs;
    return {
        kind: 'cloudproof.causal-corpus-freeze',
        schemaVersion: 1,
        corpus: path.basename(path.resolve(directory)),
        manifestKind: manifest.kind,
        manifestSchemaVersion: manifest.schemaVersion,
        generator: {
            id: manifest.generator.id,
            version: manifest.generator.version,
            commitSha: manifest.generator.commitSha,
            outcomeBlind: manifest.generator.outcomeBlind,
        },
        seeds: manifest.seeds,
        splitPolicy: manifest.splitPolicy,
        counts: manifest.counts,
        matching: {
            ...manifest.matching.counts,
            matchedByLevel: manifest.matching.matchedByLevel,
            pruningRounds: manifest.matching.pruning.rounds,
            classCap: { before: manifest.matching.classCap.before, after: manifest.matching.classCap.after },
        },
        rowCap: manifest.rowCap,
        positionBalance: Object.fromEntries(Object.entries(manifest.positionBalance).map(([split, report]) => [split,
            { rowsBefore: report.rowsBefore, rowsAfter: report.rowsAfter, targetRate: report.targetRate }])),
        sanity: {
            shortcutProbe: {
                trajectory: { aurocBySplit: probe.trajectory.aurocBySplit, pooled: probe.trajectory.pooledHeldOut },
                transition: { aurocBySplit: probe.transition[horizon].aurocBySplit, pooled: probe.transition[horizon].pooledHeldOut },
                transitionNuisanceOnly: probe.transitionTrajectoryNuisanceOnly[horizon].aurocBySplit,
                transitionPositionOnly: probe.transitionPositionOnly[horizon].aurocBySplit,
            },
            labelPermutation: {
                seeds: evaluation.evaluation.labelPermutation.seeds,
                families: evaluation.evaluation.labelPermutation.families,
                intervals95: evaluation.evaluation.labelPermutation.intervals95,
            },
            horizons: evaluation.evaluation.horizons,
            counterfactualPairs: { counts: pairs.counts, relationalOnly: pairs.relationalOnly, families: pairs.families },
            splitIntegrity: evaluation.evaluation.splitIntegrity.ok,
            replay: manifest.replay,
        },
        acceptance: evaluation.acceptance,
        files: manifest.files,
    };
}

function main(argv = process.argv.slice(2)) {
    const directory = argv[0];
    const output = argv[1];
    if (!directory || !output) throw new TypeError('usage: cloudproof-corpus-freeze.js <corpus-dir> <output.json>');
    const record = freezeRecord(directory);
    fs.writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ output, passed: record.acceptance.passed, pool: record.counts.pool })}\n`);
}

if (require.main === module) {
    try { main(); } catch (error) { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }
}

module.exports = { freezeRecord };
