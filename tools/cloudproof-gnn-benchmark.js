'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { infrastructureGraph } = require('../packages/cloudproof/graph');
const { OfflineGnnRiskScorer, riskScorerKey } = require('../packages/cloudproof/gnn-risk-scorer');
const { evaluateSchedulePrioritizers } = require('../packages/cloudproof/schedule-evaluation');
const { createCloudState } = require('../packages/cloudproof/state');
const { RiskBaseline } = require('../packages/cloudproof/transition-dataset');
const { runCloudSchedule } = require('../sim/cloud-runtime');
const { controllerStateSignature } = require('../sim/cloud-schedule');

const EDGE_MODES = Object.freeze([
    'full',
    'randomized-edges',
    'collapsed-edge-types',
    'no-edges',
    'random-relation-labels',
]);

function scorerName(mode) {
    if (mode === 'full') return 'gnn';
    return `gnn${mode.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}`;
}

function parseArgs(argv) {
    const options = {
        dataset: 'artifacts/cloudproof/research-dataset',
        model: 'artifacts/cloudproof/models/gnn-v1',
        out: 'artifacts/cloudproof/models/gnn-v1/fixed-budget.json',
        python: process.platform === 'win32' ? 'python' : 'python3',
        budgets: [100, 500, 1000, 5000],
        concurrency: 16,
        maxSchedules: null,
        edgeModes: ['full'],
    };
    for (let index = 0; index < argv.length; index += 1) {
        const name = argv[index];
        const value = argv[index + 1];
        if (name === '--dataset') options.dataset = value;
        else if (name === '--model') options.model = value;
        else if (name === '--out') options.out = value;
        else if (name === '--python') options.python = value;
        else if (name === '--budgets') options.budgets = value.split(',').map(Number);
        else if (name === '--concurrency') options.concurrency = Number(value);
        else if (name === '--max-schedules') options.maxSchedules = Number(value);
        else if (name === '--edge-modes') options.edgeModes = value.split(',').filter(Boolean);
        else throw new TypeError(`unknown argument: ${name}`);
        index += 1;
    }
    if (!options.budgets.every((value) => Number.isInteger(value) && value > 0)) {
        throw new TypeError('budgets must be positive integers');
    }
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 128) {
        throw new TypeError('concurrency must be an integer in [1, 128]');
    }
    if (options.maxSchedules !== null && (!Number.isInteger(options.maxSchedules) || options.maxSchedules < 1)) {
        throw new TypeError('max-schedules must be a positive integer');
    }
    if (!options.edgeModes.length || options.edgeModes.some((mode) => !EDGE_MODES.includes(mode))) {
        throw new TypeError(`edge-modes must be selected from: ${EDGE_MODES.join(', ')}`);
    }
    if (new Set(options.edgeModes).size !== options.edgeModes.length) {
        throw new TypeError('edge-modes must not contain duplicates');
    }
    return options;
}

function loadJsonLines(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function initialGraph(schedule) {
    return infrastructureGraph(createCloudState({
        seed: schedule.seed,
        topology: schedule.topology,
        traffic: schedule.scenarioParameters?.traffic || {},
    }));
}

function writeInferenceRequests(schedules, file) {
    const requests = new Map();
    for (const item of schedules) {
        const state = initialGraph(item.schedule);
        for (const action of item.schedule.actions) {
            const key = riskScorerKey(state, action);
            if (!requests.has(key)) requests.set(key, { key, state, action });
        }
    }
    const lines = [...requests.values()].map((value) => JSON.stringify(value)).join('\n');
    fs.writeFileSync(file, `${lines}\n`, 'utf8');
    return requests.size;
}

function runInference(options, requestFile, scoreFile, edgeMode) {
    const inference = spawnSync(options.python, [
        '-m', 'ml.cloudproof.infer', '--model', options.model,
        '--input', requestFile, '--output', scoreFile, '--edge-mode', edgeMode,
    ], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    if (inference.status !== 0) {
        throw new Error(`GNN inference failed for ${edgeMode}:\n${inference.stdout}\n${inference.stderr}`);
    }
    return OfflineGnnRiskScorer.fromJsonl(scoreFile);
}

async function replayCandidates(items, concurrency) {
    const candidates = [];
    for (let start = 0; start < items.length; start += concurrency) {
        const batch = items.slice(start, start + concurrency);
        const completed = await Promise.all(batch.map(async (item) => {
            const started = process.hrtime.bigint();
            const result = await runCloudSchedule(item.schedule, { mutant: item.schedule.runtime });
            const verificationWallTimeMs = Number(process.hrtime.bigint() - started) / 1e6;
            if (result.replayFingerprint !== item.replayFingerprint) {
                throw new Error(`replay fingerprint changed for ${item.scenarioId}`);
            }
            return {
                scenarioId: item.scenarioId,
                split: item.split,
                topologyId: item.topologyId,
                schedule: item.schedule,
                initialState: result.graphTransitions[0].state,
                verificationWallTimeMs,
                result: {
                    ok: result.ok,
                    failure: result.failure,
                    schedule: item.schedule,
                    graphTransitions: result.graphTransitions.map((row) => ({
                        action: { type: row.action.type },
                        controllerStateSignature: controllerStateSignature(row.nextState),
                    })),
                },
            };
        }));
        candidates.push(...completed);
    }
    return candidates;
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    let schedules = loadJsonLines(path.join(options.dataset, 'schedules.jsonl'))
        .filter((item) => item.split !== 'train');
    if (options.maxSchedules !== null) schedules = schedules.slice(0, options.maxSchedules);
    const baselineEvaluation = JSON.parse(fs.readFileSync(
        path.join(options.dataset, 'evaluation.json'), 'utf8',
    ));
    const logistic = RiskBaseline.from((baselineEvaluation.evaluation || baselineEvaluation).model);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudproof-gnn-'));
    try {
        const requestFile = path.join(temporary, 'requests.jsonl');
        const uniqueInferenceRequests = writeInferenceRequests(schedules, requestFile);
        const additionalScorers = {};
        for (const edgeMode of options.edgeModes) {
            const scoreFile = path.join(temporary, `${edgeMode}-scores.jsonl`);
            additionalScorers[scorerName(edgeMode)] = runInference(
                options, requestFile, scoreFile, edgeMode,
            );
        }
        const candidates = await replayCandidates(schedules, options.concurrency);
        const fixedBudget = evaluateSchedulePrioritizers(candidates, logistic, {
            budgets: options.budgets,
            randomSeed: 1337,
            additionalScorers,
        });
        const result = {
            ...fixedBudget,
            kind: 'cloudproof.gnn-fixed-budget-evaluation',
            schemaVersion: 1,
            safetyAuthority: 'deterministic-node-verifier',
            candidateSplits: ['validation', 'test', 'ood'],
            edgeModes: options.edgeModes,
            uniqueInferenceRequests,
        };
        fs.mkdirSync(path.dirname(options.out), { recursive: true });
        fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result;
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    EDGE_MODES,
    initialGraph,
    main,
    parseArgs,
    replayCandidates,
    scorerName,
    writeInferenceRequests,
};
