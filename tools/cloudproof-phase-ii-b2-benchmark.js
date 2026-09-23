#!/usr/bin/env node
'use strict';

// Phase II-B.2 fixed-budget verification benchmark on the frozen causal corpus.
//
// The held-out schedule pool is every selected validation/test/OOD trajectory
// in the frozen `trajectories.jsonl`. Each schedule is replayed through the
// unchanged deterministic simulator (the replay fingerprint must match the
// frozen record), the learned scorers rank the pool offline through the same
// Node<->Python path as Phase II-B, and `evaluateSchedulePrioritizers` compares
// Random, Coverage, Heuristic, Logistic and every learned scorer at the same
// budgets. The ranking given the scores is deterministic; only the random
// baseline carries a seed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { OfflineGnnRiskScorer, riskScorerKey } = require('../packages/cloudproof/gnn-risk-scorer');
const { evaluateSchedulePrioritizers } = require('../packages/cloudproof/schedule-evaluation');
const { RiskBaseline, extractRiskFeatures } = require('../packages/cloudproof/transition-dataset');
const { DEFAULT_HORIZON, candidateAction } = require('../sim/cloud-causal-corpus');
const { runCloudSchedule } = require('../sim/cloud-runtime');
const { controllerStateSignature } = require('../sim/cloud-schedule');
const { replayCloudArtifact } = require('../sim/cloud-search');

const EDGE_MODES = Object.freeze([
    'full',
    'randomized-edges',
    'rewired-edges',
    'collapsed-edge-types',
    'no-edges',
    'random-relation-labels',
]);
const RESERVED_SCORERS = Object.freeze(['random', 'coverageGuided', 'heuristic', 'logistic']);
const DEFAULT_EDGE_SEED = 1729;

function parseScorer(value) {
    const [name, spec] = value.split('=');
    if (!name || !spec) throw new TypeError(`scorer must be name=modelDir[:edgeMode[:edgeSeed]]: ${value}`);
    if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw new TypeError(`scorer name must be camelCase: ${name}`);
    if (RESERVED_SCORERS.includes(name)) throw new TypeError(`scorer name is reserved: ${name}`);
    const parts = spec.split(':');
    // Windows drive letters ("D:\...") also contain a colon; the edge mode is
    // recognized by name so a model path may carry one.
    let edgeMode = 'full';
    let edgeSeed = DEFAULT_EDGE_SEED;
    let modelDir = spec;
    const modeIndex = parts.findIndex((part, index) => index > 0 && EDGE_MODES.includes(part));
    if (modeIndex !== -1) {
        modelDir = parts.slice(0, modeIndex).join(':');
        edgeMode = parts[modeIndex];
        if (parts.length > modeIndex + 1) {
            edgeSeed = Number(parts[modeIndex + 1]);
            if (!Number.isInteger(edgeSeed) || edgeSeed < 0) throw new TypeError(`edge seed must be a non-negative integer: ${value}`);
        }
        if (parts.length > modeIndex + 2) throw new TypeError(`unexpected scorer suffix: ${value}`);
    }
    return { name, modelDir, edgeMode, edgeSeed };
}

function parseArgs(argv) {
    const options = {
        corpus: 'artifacts/cloudproof/causal-corpus-v2',
        freeze: 'CLOUDPROOF-PHASE-II-A2-CORPUS-FREEZE.json',
        out: 'artifacts/cloudproof/phase-ii-b2/fixed-budget.json',
        python: process.platform === 'win32' ? 'python' : 'python3',
        budgets: [100, 500, 1000, 5000],
        maxSchedules: null,
        scorers: [],
        phaseOneArtifact: path.join('artifacts', 'cloudproof', 'failure-1337.json'),
        skipFreezeCheck: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const name = argv[index];
        const value = argv[index + 1];
        if (name === '--corpus') options.corpus = value;
        else if (name === '--freeze') options.freeze = value;
        else if (name === '--out') options.out = value;
        else if (name === '--python') options.python = value;
        else if (name === '--budgets') options.budgets = value.split(',').map(Number);
        else if (name === '--max-schedules') options.maxSchedules = Number(value);
        else if (name === '--scorer') options.scorers.push(parseScorer(value));
        else if (name === '--phase-one-artifact') options.phaseOneArtifact = value;
        else if (name === '--skip-freeze-check') { options.skipFreezeCheck = true; index -= 1; }
        else throw new TypeError(`unknown argument: ${name}`);
        index += 1;
    }
    if (!options.budgets.length || !options.budgets.every((value) => Number.isInteger(value) && value > 0)) {
        throw new TypeError('budgets must be positive integers');
    }
    if (options.maxSchedules !== null && (!Number.isInteger(options.maxSchedules) || options.maxSchedules < 1)) {
        throw new TypeError('max-schedules must be a positive integer');
    }
    const names = options.scorers.map((scorer) => scorer.name);
    if (new Set(names).size !== names.length) throw new TypeError('scorer names must be unique');
    return options;
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file)
            .on('data', (chunk) => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}

async function verifyFrozenFiles(corpus, freezeFile, names) {
    const freeze = JSON.parse(fs.readFileSync(freezeFile, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
    if (freeze.kind !== 'cloudproof.causal-corpus-freeze') throw new Error('unsupported freeze record');
    if (freeze.corpus !== path.basename(path.resolve(corpus))) {
        throw new Error(`freeze record is for ${freeze.corpus}, not ${path.basename(path.resolve(corpus))}`);
    }
    if (!freeze.acceptance?.passed) throw new Error('freeze record does not carry a passed acceptance');
    const verified = {};
    for (const name of names) {
        const file = path.join(corpus, name);
        const expected = freeze.files?.[name]?.sha256;
        if (!expected) throw new Error(`freeze record has no SHA-256 for ${name}`);
        if (manifest.files?.[name]?.sha256 !== expected) throw new Error(`manifest and freeze disagree on ${name}`);
        const actual = await sha256File(file);
        if (actual !== expected) throw new Error(`SHA-256 mismatch for ${name}: ${actual} != ${expected}`);
        if (fs.statSync(file).size !== freeze.files[name].bytes) throw new Error(`byte count mismatch for ${name}`);
        verified[name] = actual;
    }
    return {
        freezeFile,
        freezeDigest: await sha256File(freezeFile),
        generatorCommitSha: freeze.generator?.commitSha || null,
        files: verified,
    };
}

async function* readJsonLines(file) {
    const reader = readline.createInterface({
        input: fs.createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });
    for await (const line of reader) {
        if (line.trim()) yield JSON.parse(line);
    }
}

async function loadHeldOutPool(corpus, maxSchedules) {
    const pool = [];
    for await (const trajectory of readJsonLines(path.join(corpus, 'trajectories.jsonl'))) {
        if (!trajectory.selected || trajectory.split === 'train') continue;
        pool.push({
            scenarioId: trajectory.trajectoryId,
            trajectoryId: trajectory.trajectoryId,
            split: trajectory.split,
            topologyId: trajectory.topologyId,
            tier: trajectory.difficulty?.tier ?? null,
            outcome: trajectory.outcome,
            violationClass: trajectory.incident?.violationClass || null,
            schedule: trajectory.schedule,
            replayFingerprint: trajectory.replayFingerprint,
        });
        if (maxSchedules !== null && pool.length >= maxSchedules) break;
    }
    return pool;
}

// The same compact candidate the corpus pipeline builds (`compactCandidate` in
// sim/cloud-causal-corpus.js): position-free actions for scoring, the initial
// graph, and a deduplicated controller-state trace for coverage.
function candidateFromReplay(item, result, verificationWallTimeMs) {
    const seen = new Set();
    const transitions = [];
    for (const row of result.graphTransitions) {
        const signature = controllerStateSignature(row.nextState);
        const key = `${row.action.type}|${signature}`;
        if (seen.has(key)) continue;
        seen.add(key);
        transitions.push({ action: { type: row.action.type }, controllerStateSignature: signature });
    }
    const actions = item.schedule.actions.map(candidateAction);
    return {
        scenarioId: item.trajectoryId,
        trajectoryId: item.trajectoryId,
        split: item.split,
        topologyId: item.topologyId,
        tier: item.tier,
        schedule: { ...item.schedule, actions },
        initialState: result.graphTransitions[0].state,
        verificationWallTimeMs,
        result: {
            ok: result.ok,
            failure: result.failure ? { violationClass: result.failure.violationClass } : null,
            schedule: { actions },
            graphTransitions: transitions,
        },
    };
}

async function replayTrajectory(item) {
    const started = process.hrtime.bigint();
    const result = await runCloudSchedule(item.schedule, {
        mutant: item.schedule.runtime,
        horizonTransitions: DEFAULT_HORIZON,
    });
    const verificationWallTimeMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (item.replayFingerprint && result.replayFingerprint !== item.replayFingerprint) {
        throw new Error(`replay fingerprint changed for ${item.trajectoryId}`);
    }
    if (item.outcome && result.ok !== (item.outcome === 'safe')) {
        throw new Error(`replay outcome changed for ${item.trajectoryId}`);
    }
    if (item.violationClass && result.failure?.violationClass !== item.violationClass) {
        throw new Error(`replay violation class changed for ${item.trajectoryId}`);
    }
    return candidateFromReplay(item, result, verificationWallTimeMs);
}

async function replayPool(pool, log = () => {}) {
    const candidates = [];
    for (let index = 0; index < pool.length; index += 1) {
        candidates.push(await replayTrajectory(pool[index]));
        if ((index + 1) % 500 === 0) log(`replayed ${index + 1}/${pool.length}`);
    }
    return candidates;
}

function uniqueRequests(candidates) {
    const requests = new Map();
    for (const candidate of candidates) {
        for (const action of candidate.schedule.actions) {
            const key = riskScorerKey(candidate.initialState, action);
            if (!requests.has(key)) requests.set(key, { key, state: candidate.initialState, action });
        }
    }
    return requests;
}

function writeRequests(requests, file) {
    const lines = [...requests.values()].map((value) => JSON.stringify(value)).join('\n');
    fs.writeFileSync(file, `${lines}\n`, 'utf8');
}

function runInference(options, scorer, requestFile, scoreFile) {
    const started = process.hrtime.bigint();
    const inference = spawnSync(options.python, [
        '-m', 'ml.cloudproof.infer', '--model', scorer.modelDir,
        '--input', requestFile, '--output', scoreFile,
        '--edge-mode', scorer.edgeMode, '--edge-seed', String(scorer.edgeSeed),
    ], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (inference.status !== 0) {
        throw new Error(`inference failed for ${scorer.name}:\n${inference.stdout}\n${inference.stderr}`);
    }
    return {
        scorer: OfflineGnnRiskScorer.fromJsonl(scoreFile),
        inferenceWallTimeMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
}

function loadLogistic(corpus) {
    const evaluation = JSON.parse(fs.readFileSync(path.join(corpus, 'evaluation.json'), 'utf8'));
    const model = (evaluation.evaluation || evaluation).models?.[String(DEFAULT_HORIZON)];
    if (!model) throw new Error(`corpus evaluation has no K=${DEFAULT_HORIZON} logistic baseline`);
    return RiskBaseline.from(model);
}

// Re-assert, in Node, that the nine flat risk features are identical for every
// valid relational-only pair: the linear baselines tie on them by construction.
async function relationalFlatIdentity(pairsFile) {
    const pairs = new Map();
    for await (const record of readJsonLines(pairsFile)) {
        if (!record.relationalOnly || !record.metadata?.valid) continue;
        const entry = pairs.get(record.pairId) || {};
        entry[record.variant] = extractRiskFeatures(record.state, record.action);
        pairs.set(record.pairId, entry);
    }
    let identical = 0;
    for (const entry of pairs.values()) {
        if (!entry.A || !entry.B) throw new Error('incomplete relational-only pair');
        if (JSON.stringify(entry.A) === JSON.stringify(entry.B)) identical += 1;
    }
    return { validRelationalPairs: pairs.size, flatFeaturesIdentical: identical };
}

// The shared evaluator exports every covered controller-state signature at
// every checkpoint (thousands of strings x methods x budgets). The committed
// result keeps the count and replaces the list with its SHA-256; the full
// export is written next to it under raw/.
function compactCoverage(result) {
    const compact = JSON.parse(JSON.stringify(result));
    for (const method of Object.values(compact.methods || {})) {
        for (const checkpoint of Object.values(method.budgets || {})) {
            const states = checkpoint.controllerStateCoverage?.controllerStates;
            if (!states || !Array.isArray(states.signatures)) continue;
            states.signaturesSha256 = crypto.createHash('sha256')
                .update(JSON.stringify(states.signatures)).digest('hex');
            delete states.signatures;
        }
    }
    return compact;
}

function poolSummary(candidates) {
    const bySplit = {};
    for (const candidate of candidates) {
        const entry = bySplit[candidate.split] = bySplit[candidate.split] || { schedules: 0, counterexamples: 0 };
        entry.schedules += 1;
        if (!candidate.result.ok) entry.counterexamples += 1;
    }
    return {
        schedules: candidates.length,
        counterexamples: candidates.filter((candidate) => !candidate.result.ok).length,
        bySplit,
    };
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const log = (message) => process.stderr.write(`[phase-ii-b2-benchmark] ${message}\n`);
    const started = process.hrtime.bigint();
    const frozen = options.skipFreezeCheck
        ? null
        : await verifyFrozenFiles(options.corpus, options.freeze, ['trajectories.jsonl', 'counterfactual-pairs.jsonl']);
    if (frozen) log('frozen files verified');
    const pool = await loadHeldOutPool(options.corpus, options.maxSchedules);
    log(`held-out pool: ${pool.length} schedules`);
    const candidates = await replayPool(pool, log);
    const logistic = loadLogistic(options.corpus);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudproof-phase-ii-b2-'));
    try {
        const requestFile = path.join(temporary, 'requests.jsonl');
        const requests = uniqueRequests(candidates);
        writeRequests(requests, requestFile);
        log(`${requests.size} unique inference requests`);
        const additionalScorers = {};
        const scorerReports = {};
        for (const scorer of options.scorers) {
            const scoreFile = path.join(temporary, `${scorer.name}.jsonl`);
            const { scorer: offline, inferenceWallTimeMs } = runInference(options, scorer, requestFile, scoreFile);
            additionalScorers[scorer.name] = offline;
            scorerReports[scorer.name] = {
                modelDir: scorer.modelDir,
                edgeMode: scorer.edgeMode,
                edgeSeed: scorer.edgeMode === 'full' ? null : scorer.edgeSeed,
                inferenceWallTimeMs,
            };
            log(`scored ${scorer.name} in ${Math.round(inferenceWallTimeMs)} ms`);
        }
        const fixedBudget = evaluateSchedulePrioritizers(candidates, logistic, {
            budgets: options.budgets,
            randomSeed: 1337,
            additionalScorers,
        });
        const flatIdentity = await relationalFlatIdentity(path.join(options.corpus, 'counterfactual-pairs.jsonl'));
        let phaseOne = null;
        if (fs.existsSync(options.phaseOneArtifact)) {
            const replay = await replayCloudArtifact(options.phaseOneArtifact);
            phaseOne = {
                file: options.phaseOneArtifact,
                byteIdentical: replay.byteIdentical,
                sameFailure: replay.sameFailure,
                violationClass: replay.result.failure?.violationClass || null,
            };
        }
        const result = {
            ...fixedBudget,
            kind: 'cloudproof.phase-ii-b2-fixed-budget',
            schemaVersion: 1,
            phase: 'II-B.2',
            safetyAuthority: 'deterministic-node-verifier',
            frozenCorpus: frozen,
            candidateSplits: ['validation', 'test', 'ood'],
            pool: poolSummary(candidates),
            replayFingerprintsVerified: candidates.length,
            uniqueInferenceRequests: requests.size,
            scorers: scorerReports,
            logisticBaseline: `corpus evaluation.json models[${DEFAULT_HORIZON}]`,
            scheduleRiskRule: 'maximum scorer risk over the schedule\'s position-free actions against the initial graph',
            determinism: 'rankings are deterministic given the scores; only the random baseline is seeded (1337); no repeated random trials are claimed',
            relationalOnlyFlatFeatures: flatIdentity,
            phaseOneReplay: phaseOne,
            wallTimeMs: Number(process.hrtime.bigint() - started) / 1e6,
        };
        fs.mkdirSync(path.dirname(options.out), { recursive: true });
        const rawFile = path.join(path.dirname(options.out), 'raw', path.basename(options.out).replace(/\.json$/, '-full.json'));
        fs.mkdirSync(path.dirname(rawFile), { recursive: true });
        fs.writeFileSync(rawFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
        fs.writeFileSync(options.out, `${JSON.stringify({ ...compactCoverage(result), fullCoverageExport: path.relative(path.dirname(options.out), rawFile).split(path.sep).join('/') }, null, 2)}\n`, 'utf8');
        const summary = Object.fromEntries(Object.entries(result.methods).map(([name, method]) => [
            name,
            Object.fromEntries(Object.entries(method.budgets).map(([budget, checkpoint]) => [budget, checkpoint.failuresFound])),
        ]));
        process.stdout.write(`${JSON.stringify({ out: options.out, pool: result.pool, failuresFound: summary }, null, 2)}\n`);
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
    candidateFromReplay,
    compactCoverage,
    loadHeldOutPool,
    main,
    parseArgs,
    parseScorer,
    relationalFlatIdentity,
    replayTrajectory,
    uniqueRequests,
    verifyFrozenFiles,
};
