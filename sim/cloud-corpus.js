'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { digest } = require('../packages/agent-runtime');
const { canonicalGraphSerialization } = require('../packages/cloudproof/graph');
const { evaluateSchedulePrioritizers, DEFAULT_VERIFICATION_BUDGETS }
    = require('../packages/cloudproof/schedule-evaluation');
const { stable } = require('../packages/cloudproof/state');
const {
    RiskBaseline,
    evaluateRiskBaseline,
    extractRiskFeatures,
    heuristicRiskScore,
    riskLabel,
} = require('../packages/cloudproof/transition-dataset');
const {
    DATASET_SCHEMA_VERSION,
    SPLIT_POLICY,
    TOPOLOGY_CATALOG,
    assertDisjointTopologySplits,
} = require('../packages/cloudproof/topology');
const { CLOUD_FAULT } = require('../packages/cloudproof/faults');
const {
    CLOUD_SCHEDULE_SCHEMA_VERSION,
    reindexCloudActions,
    validateCloudSchedule,
} = require('./cloud-actions');
const { runCloudSchedule } = require('./cloud-runtime');
const { controllerStateSignature, materializeCloudSchedule } = require('./cloud-schedule');

const TRAFFIC_PROFILES = Object.freeze({
    low: Object.freeze({ cpuPercent: 35, latencyMs: 12, requestsPerSecond: 60 }),
    normal: Object.freeze({ cpuPercent: 55, latencyMs: 18, requestsPerSecond: 120 }),
    spike: Object.freeze({ cpuPercent: 91, latencyMs: 126, requestsPerSecond: 480 }),
});
const SPLITS = Object.freeze(['train', 'validation', 'test', 'ood']);
const DATASET_FILENAMES = Object.freeze({
    train: 'transitions-train.jsonl',
    validation: 'transitions-validation.jsonl',
    test: 'transitions-test.jsonl',
    ood: 'transitions-ood.jsonl',
});

function unsafeVariants(entry) {
    const variants = ['endpoint-includes-unready', 'hpa-stale-indefinitely'];
    if (entry.topology.maxUnavailable > 0) variants.push('rollout-ignores-terminating');
    return variants;
}

function scenarioDescriptor(index, seed, entry, catalogIndex, catalogLength = TOPOLOGY_CATALOG.length) {
    const cycle = Math.floor(index / catalogLength);
    const unsafe = index % 2 === 1;
    const trafficProfiles = Object.keys(TRAFFIC_PROFILES);
    const trafficProfile = unsafe
        ? trafficProfiles[(cycle + catalogIndex) % trafficProfiles.length]
        : 'low';
    const variants = unsafeVariants(entry);
    const runtime = unsafe ? variants[(Math.floor(cycle / 2) + catalogIndex) % variants.length] : 'correct';
    return stable({
        intendedOutcome: unsafe ? 'unsafe' : 'safe',
        runtime,
        scenarioFamily: unsafe ? 'mutant' : 'safe',
        seed,
        split: entry.split,
        topologyId: entry.topologyId,
        topologyLabel: entry.label,
        traffic: TRAFFIC_PROFILES[trafficProfile],
        trafficProfile,
    });
}

function augmentFaultCombination(schedule, descriptor) {
    if (descriptor.runtime !== 'endpoint-includes-unready') return schedule;
    schedule.actions = reindexCloudActions([
        { type: CLOUD_FAULT.IMAGE_PULL_DELAY, delayMs: 650 },
        { type: CLOUD_FAULT.ENDPOINT_PROPAGATION_DELAY, delayMs: 150 },
        ...schedule.actions,
    ]);
    return schedule;
}

function materializeResearchSchedule(descriptor, entry) {
    const schedule = materializeCloudSchedule(descriptor.seed, {
        scenario: descriptor.scenarioFamily,
        runtime: descriptor.runtime,
        strategy: 'research-corpus',
        noise: descriptor.intendedOutcome === 'safe' ? descriptor.seed % 4 : 0,
        topology: entry.topology,
        scenarioParameters: {
            traffic: descriptor.traffic,
            trafficProfile: descriptor.trafficProfile,
        },
    });
    augmentFaultCombination(schedule, descriptor);
    schedule.scenarioId = `scenario-${digest({ descriptor, schedule }).slice(0, 20)}`;
    schedule.scenarioParameters = stable({
        ...schedule.scenarioParameters,
        faultCombination: schedule.actions.filter((action) => action.type.startsWith('cloud.fault.'))
            .map((action) => action.type),
        intendedOutcome: descriptor.intendedOutcome,
    });
    validateCloudSchedule(schedule);
    return schedule;
}

function datasetRecord(row, schedule, descriptor, result) {
    canonicalGraphSerialization(row.state);
    canonicalGraphSerialization(row.nextState);
    return stable({
        datasetSchemaVersion: DATASET_SCHEMA_VERSION,
        recordId: `${schedule.scenarioId}:transition-${row.sequence}`,
        scenarioId: schedule.scenarioId,
        topologyId: descriptor.topologyId,
        split: descriptor.split,
        state: row.state,
        action: row.action,
        nextState: row.nextState,
        labels: row.labels,
        metadata: {
            ...row.metadata,
            seed: descriptor.seed,
            topologyLabel: descriptor.topologyLabel,
            trafficProfile: descriptor.trafficProfile,
            scenarioFamily: descriptor.scenarioFamily,
            runtime: descriptor.runtime,
            trajectoryOutcome: result.ok ? 'safe' : 'unsafe',
            faultCombination: schedule.scenarioParameters.faultCombination,
            featureBoundary: 'state-and-candidate-action-only',
        },
    });
}

function compactExample(row) {
    return stable({
        features: extractRiskFeatures(row, row.action),
        heuristicScore: heuristicRiskScore(row.state, row.action),
        labels: {
            sloViolationWithinKTransitions: riskLabel(row),
            sloViolationWithin1000ms: Boolean(row.labels.sloViolationWithin1000ms),
        },
    });
}

function compactCandidate(schedule, descriptor, result, verificationWallTimeMs) {
    return {
        scenarioId: schedule.scenarioId,
        split: descriptor.split,
        topologyId: descriptor.topologyId,
        schedule,
        initialState: result.graphTransitions[0].state,
        verificationWallTimeMs,
        result: {
            ok: result.ok,
            failure: result.failure,
            schedule,
            graphTransitions: result.graphTransitions.map((row) => ({
                action: { type: row.action.type },
                controllerStateSignature: controllerStateSignature(row.nextState),
            })),
        },
    };
}

function emptyDistribution() {
    return { schedules: 0, transitions: 0, safe: 0, unsafe: 0 };
}

function gitCommitSha() {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch (_) {
        return 'unknown';
    }
}

function openOutputs(outputDirectory) {
    if (!outputDirectory) return null;
    const resolved = path.resolve(outputDirectory);
    fs.mkdirSync(resolved, { recursive: true });
    const handles = Object.fromEntries(SPLITS.map((split) => [split,
        fs.openSync(path.join(resolved, DATASET_FILENAMES[split]), 'w')]));
    handles.schedules = fs.openSync(path.join(resolved, 'schedules.jsonl'), 'w');
    return { directory: resolved, handles };
}

function closeOutputs(outputs) {
    if (!outputs) return;
    Object.values(outputs.handles).forEach((handle) => fs.closeSync(handle));
}

function writeLine(handle, value) {
    if (handle !== undefined) fs.writeSync(handle, `${JSON.stringify(stable(value))}\n`, null, 'utf8');
}

async function hashFile(file) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        const input = fs.createReadStream(file);
        input.on('data', (chunk) => hash.update(chunk));
        input.on('end', resolve);
        input.on('error', reject);
    });
    return hash.digest('hex');
}

async function generatedFileMetadata(outputs) {
    if (!outputs) return null;
    const names = [...Object.values(DATASET_FILENAMES), 'schedules.jsonl'];
    const metadata = {};
    for (const name of names) {
        const file = path.join(outputs.directory, name);
        metadata[name] = { bytes: fs.statSync(file).size, sha256: await hashFile(file) };
    }
    return stable(metadata);
}

async function executeScenario(index, seedStart, catalog) {
    const entry = catalog[index % catalog.length];
    const descriptor = scenarioDescriptor(index, seedStart + index, entry,
        index % catalog.length, catalog.length);
    const schedule = materializeResearchSchedule(descriptor, entry);
    const started = process.hrtime.bigint();
    const result = await runCloudSchedule(schedule, { mutant: descriptor.runtime });
    return {
        descriptor,
        result,
        schedule,
        verificationWallTimeMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
}

async function generateResearchCorpus(options = {}) {
    const simulations = options.simulations ?? 10000;
    const seedStart = options.seedStart ?? 20000;
    const catalog = options.catalog || TOPOLOGY_CATALOG;
    const concurrency = options.concurrency ?? 16;
    if (!Number.isInteger(simulations) || simulations < 1) throw new TypeError('simulations must be positive');
    if (!Number.isInteger(seedStart)) throw new TypeError('seedStart must be an integer');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128) {
        throw new TypeError('concurrency must be an integer in [1, 128]');
    }
    assertDisjointTopologySplits(catalog);
    const outputs = openOutputs(options.outputDirectory || null);
    const examplesBySplit = Object.fromEntries(SPLITS.map((split) => [split, []]));
    const distributions = Object.fromEntries(SPLITS.map((split) => [split, emptyDistribution()]));
    const candidates = [];
    let transitions = 0;
    try {
        for (let batchStart = 0; batchStart < simulations; batchStart += concurrency) {
            const batchEnd = Math.min(simulations, batchStart + concurrency);
            const batch = await Promise.all(Array.from({ length: batchEnd - batchStart }, (_, offset) => (
                executeScenario(batchStart + offset, seedStart, catalog)
            )));
            for (const { descriptor, result, schedule, verificationWallTimeMs } of batch) {
            const outcome = result.ok ? 'safe' : 'unsafe';
            if (outcome !== descriptor.intendedOutcome) {
                throw new Error(`${schedule.scenarioId} (${descriptor.topologyLabel}/${descriptor.runtime}) `
                    + `expected ${descriptor.intendedOutcome} but was ${outcome}`);
            }
            const distribution = distributions[descriptor.split];
            distribution.schedules += 1;
            distribution[outcome] += 1;
            distribution.transitions += result.graphTransitions.length;
            transitions += result.graphTransitions.length;
            for (const row of result.graphTransitions) {
                const record = datasetRecord(row, schedule, descriptor, result);
                examplesBySplit[descriptor.split].push(compactExample(record));
                writeLine(outputs?.handles[descriptor.split], record);
            }
            const candidate = compactCandidate(schedule, descriptor, result, verificationWallTimeMs);
            candidates.push(candidate);
            writeLine(outputs?.handles.schedules, {
                scenarioId: schedule.scenarioId,
                topologyId: descriptor.topologyId,
                split: descriptor.split,
                outcome,
                failureClass: result.failure?.violationClass || null,
                replayFingerprint: result.replayFingerprint,
                schedule,
            });
            }
        }
    } finally {
        closeOutputs(outputs);
    }
    const files = await generatedFileMetadata(outputs);
    const safe = Object.values(distributions).reduce((sum, value) => sum + value.safe, 0);
    const unsafe = Object.values(distributions).reduce((sum, value) => sum + value.unsafe, 0);
    const manifest = stable({
        kind: 'cloudproof.research-dataset-manifest',
        schemaVersion: DATASET_SCHEMA_VERSION,
        generator: { commitSha: options.generatorCommitSha || gitCommitSha(), concurrency },
        simulatorSchemas: {
            clusterState: 1,
            infrastructureGraph: 1,
            schedule: CLOUD_SCHEDULE_SCHEMA_VERSION,
            transitionDataset: DATASET_SCHEMA_VERSION,
        },
        seeds: { first: seedStart, last: seedStart + simulations - 1, count: simulations },
        simulations,
        transitions,
        splitPolicy: SPLIT_POLICY,
        label: { task: 'SLO violation within next K transitions', horizonTransitions: 5 },
        features: {
            inputs: ['state', 'candidateAction'],
            excluded: ['nextState', 'labels', 'trajectoryOutcome', 'failureClass'],
            boundary: 'state-and-candidate-action-only',
        },
        balance: { safe, unsafe, absoluteDifference: Math.abs(safe - unsafe) },
        distributions,
        parameters: {
            trafficProfiles: TRAFFIC_PROFILES,
            topologyCatalog: catalog,
            scenarioFamilies: ['safe', 'mutant'],
            supportedFaults: Object.values(CLOUD_FAULT),
        },
        files,
    });
    if (outputs) fs.writeFileSync(path.join(outputs.directory, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return { candidates, examplesBySplit, manifest, outputDirectory: outputs?.directory || null };
}

function evaluateResearchCorpus(corpus, options = {}) {
    const training = corpus.examplesBySplit.train;
    if (!training.length) throw new Error('training split is empty');
    const model = new RiskBaseline().train(training, {
        iterations: options.iterations ?? 100,
        learningRate: options.learningRate ?? 0.08,
    });
    const transitionMetrics = {};
    for (const split of ['validation', 'test', 'ood']) {
        const records = corpus.examplesBySplit[split];
        if (records.length) transitionMetrics[split] = evaluateRiskBaseline(model, records, {
            randomSeed: (options.randomSeed ?? 1337) + SPLITS.indexOf(split),
        });
    }
    const heldOut = corpus.candidates.filter((candidate) => candidate.split !== 'train');
    return stable({
        kind: 'cloudproof.research-evaluation',
        schemaVersion: 1,
        model: model.export(),
        transitionMetrics,
        schedulePrioritization: evaluateSchedulePrioritizers(heldOut, model, {
            budgets: options.budgets || DEFAULT_VERIFICATION_BUDGETS,
            randomSeed: options.randomSeed ?? 1337,
        }),
    });
}

function evaluateAcceptanceGates(corpus, evaluation, options = {}) {
    const minimumSimulations = options.minimumSimulations ?? 10000;
    const catalog = corpus.manifest.parameters.topologyCatalog;
    const splitSets = Object.fromEntries(SPLITS.map((split) => [split,
        new Set(catalog.filter((entry) => entry.split === split).map((entry) => entry.topologyId))]));
    const ids = SPLITS.flatMap((split) => [...splitSets[split]]);
    const topologyDisjoint = ids.length === new Set(ids).size;
    const trainingReplicas = catalog.filter((entry) => entry.split === 'train')
        .map((entry) => entry.topology.initialReplicas);
    const oodReplicas = catalog.filter((entry) => entry.split === 'ood')
        .map((entry) => entry.topology.initialReplicas);
    const requiredMetrics = ['auroc', 'auprc', 'brierScore', 'expectedCalibrationError'];
    const metricsComplete = ['validation', 'test', 'ood'].every((name) => (
        Boolean(evaluation.transitionMetrics[name])
        && ['random', 'heuristic', 'logistic'].every((method) => (
            requiredMetrics.every((metric) => Object.hasOwn(evaluation.transitionMetrics[name][method], metric))
        ))
    ));
    const methods = evaluation.schedulePrioritization.methods;
    const expectedBudgets = options.budgets || DEFAULT_VERIFICATION_BUDGETS;
    const prioritizersComplete = ['random', 'coverageGuided', 'heuristic', 'logistic'].every((method) => (
        Boolean(methods[method])
        && expectedBudgets.every((budget) => Boolean(methods[method].budgets[String(budget)]))
    ));
    const gates = stable({
        minimumCorpusSize: corpus.manifest.simulations >= minimumSimulations,
        safeUnsafeBalance: corpus.manifest.balance.absoluteDifference <= 1,
        topologyHeldOutSplits: topologyDisjoint && splitSets.validation.size > 0 && splitSets.test.size > 0,
        explicitOodSplit: trainingReplicas.every((value) => value <= 6)
            && oodReplicas.length > 0 && oodReplicas.every((value) => value >= 8),
        leakageBoundaryDeclared: corpus.manifest.splitPolicy === SPLIT_POLICY
            && corpus.manifest.features.boundary === 'state-and-candidate-action-only'
            && corpus.manifest.features.excluded.includes('nextState'),
        baselineMetricsComplete: metricsComplete,
        fixedBudgetPrioritizersComplete: prioritizersComplete,
    });
    return stable({ passed: Object.values(gates).every(Boolean), gates });
}

module.exports = {
    DATASET_FILENAMES,
    TRAFFIC_PROFILES,
    evaluateAcceptanceGates,
    evaluateResearchCorpus,
    generateResearchCorpus,
    materializeResearchSchedule,
    scenarioDescriptor,
};
