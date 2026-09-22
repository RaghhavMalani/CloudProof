#!/usr/bin/env node
'use strict';

// Phase II-A.2: generate, match, probe, and gate the CloudProof causal corpus.
//
//   node tools/cloudproof-causal-corpus.js \
//     --trajectories 20000 --seed 90000 --pairs 800 --pair-seed 95000 \
//     --out artifacts/cloudproof/causal-corpus-v2
//
// The command exits non-zero unless every corpus-repair acceptance gate passes.
// Smoke variant (CI): --trajectories 120 --minimum-trajectories 120
//   --minimum-matched-pairs 10 --minimum-discordant-pairs 1 --pairs 24 --budgets 2,4,8

const fs = require('node:fs');
const path = require('node:path');
const { generateCausalCorpus, writeAcceptedManifest } = require('../sim/cloud-causal-pipeline');
const { evaluateCausalAcceptance, evaluateCausalCorpus } = require('../sim/cloud-causal-evaluation');

function parseArgs(argv = process.argv.slice(2)) {
    const options = {
        trajectories: 20000,
        seedStart: 90000,
        pairs: 800,
        pairSeedStart: 95000,
        outputDirectory: path.join('artifacts', 'cloudproof', 'causal-corpus-v2'),
        budgets: [100, 500, 1000, 5000],
        iterations: 400,
        workers: undefined,
        caliper: 0.8,
        pruneTargetAuroc: 0.55,
        pruneDropFraction: 0.1,
        pruneMaxRounds: 15,
        pruneFloorFraction: 0.4,
        shortcutAurocMax: 0.55,
        shortcutAurocHardMax: 0.65,
        minimumSafe: 1,
        minimumUnsafe: 1,
        smdMax: 0.25,
        permutationBand: 0.05,
        minimumTrajectories: 20000,
        minimumMatchedPairs: 4000,
        minimumDiscordantPairs: 100,
        probeTrainLimit: 60000,
        probeEvaluationLimit: 30000,
        parameters: {},
        checkpoint: {},
        quiet: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--quiet') { options.quiet = true; continue; }
        const value = argv[++index];
        if (value === undefined) throw new TypeError(`missing value for ${token}`);
        if (token === '--trajectories' || token === '--simulations') options.trajectories = Number(value);
        else if (token === '--counterfactual-pairs') options.pairs = Number(value);
        else if (token === '--permutation-seeds') options.permutationSeeds = value.split(',').map(Number);
        else if (token === '--minimum-safe') options.minimumSafe = Number(value);
        else if (token === '--minimum-unsafe') options.minimumUnsafe = Number(value);
        else if (token === '--shortcut-auroc-hard-max') options.shortcutAurocHardMax = Number(value);
        else if (token === '--seed') options.seedStart = Number(value);
        else if (token === '--pairs') options.pairs = Number(value);
        else if (token === '--pair-seed') options.pairSeedStart = Number(value);
        else if (token === '--out') options.outputDirectory = value;
        else if (token === '--budgets') options.budgets = value.split(',').map(Number);
        else if (token === '--iterations') options.iterations = Number(value);
        else if (token === '--workers') options.workers = Number(value);
        else if (token === '--caliper') options.caliper = Number(value);
        else if (token === '--prune-target-auroc') options.pruneTargetAuroc = Number(value);
        else if (token === '--prune-drop-fraction') options.pruneDropFraction = Number(value);
        else if (token === '--prune-max-rounds') options.pruneMaxRounds = Number(value);
        else if (token === '--prune-floor-fraction') options.pruneFloorFraction = Number(value);
        else if (token === '--shortcut-auroc-max') options.shortcutAurocMax = Number(value);
        else if (token === '--smd-max') options.smdMax = Number(value);
        else if (token === '--permutation-band') options.permutationBand = Number(value);
        else if (token === '--permutation-mean-band') options.permutationMeanBand = Number(value);
        else if (token === '--permutation-trial-band') options.permutationTrialBand = Number(value);
        else if (token === '--minimum-trajectories') options.minimumTrajectories = Number(value);
        else if (token === '--minimum-matched-pairs') options.minimumMatchedPairs = Number(value);
        else if (token === '--minimum-discordant-pairs') options.minimumDiscordantPairs = Number(value);
        else if (token === '--probe-train-limit') options.probeTrainLimit = Number(value);
        else if (token === '--probe-evaluation-limit') options.probeEvaluationLimit = Number(value);
        else if (token === '--checkpoint-tick-rate') options.checkpoint.tickRate = Number(value);
        else if (token === '--checkpoint-timer-rate') options.checkpoint.timerRate = Number(value);
        else if (token === '--parameters') options.parameters = JSON.parse(fs.readFileSync(value, 'utf8'));
        else throw new TypeError(`unknown option: ${token}`);
    }
    return options;
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const started = Date.now();
    const log = options.quiet ? () => {} : (message) => process.stderr.write(`[causal-corpus +${Math.round((Date.now() - started) / 1000)}s] ${message}\n`);
    const corpus = await generateCausalCorpus({ ...options, log });
    log('evaluating baselines, probes, permutation controls, and pairs');
    const evaluation = evaluateCausalCorpus(corpus, options);
    const acceptance = evaluateCausalAcceptance(corpus, evaluation, options);
    writeAcceptedManifest(corpus, evaluation, acceptance);
    const probe = evaluation.shortcutProbe;
    process.stdout.write(`${JSON.stringify({
        output: corpus.outputDirectory,
        counts: corpus.manifest.counts,
        shortcutProbe: {
            trajectoryMaxAuroc: probe.trajectory.maxAuroc,
            transitionMaxAuroc: probe.transition[String(evaluation.defaultHorizon)].maxAuroc,
        },
        labelPermutation: {
            meanAuroc: evaluation.labelPermutation.meanAuroc,
            minAuroc: evaluation.labelPermutation.minAuroc,
            maxAuroc: evaluation.labelPermutation.maxAuroc,
        },
        horizons: evaluation.horizons.positiveRates,
        counterfactualPairs: evaluation.counterfactualPairs.counts,
        splitIntegrity: evaluation.splitIntegrity.ok,
        acceptance,
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
    }, null, 2)}\n`);
    if (!acceptance.passed) process.exitCode = 1;
    return { corpus, evaluation, acceptance };
}

if (require.main === module) void main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});

module.exports = { main, parseArgs };
