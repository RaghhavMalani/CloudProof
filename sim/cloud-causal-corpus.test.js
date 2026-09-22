'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { modelInput, extractRiskFeatures } = require('../packages/cloudproof/transition-dataset');
const { TOPOLOGY_CATALOG, TOPOLOGY_CATALOG_V2 } = require('../packages/cloudproof/topology');
const {
    NUISANCE_FEATURE_NAMES,
    ShortcutProbe,
    matchTrajectories,
    nuisanceVector,
    probeFeatureNames,
    shuffledLabels,
    trajectoryProbeVector,
    transitionProbeVector,
} = require('../packages/cloudproof/nuisance');
const { replayCloudArtifact } = require('./cloud-search');
const generator = require('./cloud-causal-generator');
const corpus = require('./cloud-causal-corpus');
const { generateCausalCorpus, writeAcceptedManifest } = require('./cloud-causal-pipeline');
const { evaluateCausalAcceptance, evaluateCausalCorpus, splitIntegrity } = require('./cloud-causal-evaluation');

const OUTCOME_CONTROL_TOKENS = ['desiredOutcome', 'intendedOutcome', 'wantUnsafe', 'wantSafe',
    'targetFailureClass', 'expectedViolation', 'mutantExpectedToFail'];

function firstOf(outcome, limit = 60) {
    return (async () => {
        for (let index = 0; index < limit; index += 1) {
            const result = await corpus.executeCausalTrajectory(index, {}, true);
            if (result.summary.outcome === outcome) return result;
        }
        throw new Error(`no ${outcome} trajectory in the first ${limit} seeds`);
    })();
}

test('same seed and config produce a byte-identical scenario and replay fingerprint', async () => {
    const entry = TOPOLOGY_CATALOG_V2[3];
    const first = generator.materializeCausalSchedule(90003, entry);
    const second = generator.materializeCausalSchedule(90003, entry);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    const one = await corpus.executeCausalTrajectory(3, {});
    const two = await corpus.executeCausalTrajectory(3, {});
    assert.equal(one.summary.replayFingerprint, two.summary.replayFingerprint);
    assert.equal(one.summary.scheduleDigest, two.summary.scheduleDigest);
});

test('the generator has no outcome-control surface: flags are rejected and absent from source', () => {
    const entry = TOPOLOGY_CATALOG_V2[0];
    for (const token of OUTCOME_CONTROL_TOKENS) {
        assert.throws(() => generator.sampleWorld(1, entry, { [token]: true }), /unknown generator parameter/);
        assert.throws(() => generator.mergeParameters({ [token]: 'unsafe' }), /unknown generator parameter/);
    }
    const world = generator.sampleWorld(1, entry);
    assert.throws(() => generator.sampleActions(1, world, generator.DEFAULT_GENERATOR_PARAMETERS,
        { desiredOutcome: 'unsafe' }), /unknown sampleActions option/);
    const source = fs.readFileSync(path.join(__dirname, 'cloud-causal-generator.js'), 'utf8');
    for (const token of OUTCOME_CONTROL_TOKENS) assert.ok(!source.includes(token), `generator mentions ${token}`);
    assert.ok(!source.includes('runCloudSchedule'), 'the generator must not execute anything');
    const executor = fs.readFileSync(path.join(__dirname, 'cloud-causal-corpus.js'), 'utf8');
    assert.ok(!/expected .* but was/.test(executor), 'no execution-vs-intent guard may exist');
});

test('safe and unsafe trajectories come from one generator path and are labelled only after execution', async () => {
    const safe = await firstOf('safe');
    const unsafe = await firstOf('unsafe');
    for (const result of [safe, unsafe]) {
        const { schedule } = corpus.regenerateSchedule(result.summary.index, {});
        assert.equal(schedule.scenario, 'causal');
        assert.equal(schedule.strategy, 'causal-corpus');
        assert.ok(!('intendedOutcome' in schedule.scenarioParameters));
        assert.equal(JSON.stringify(schedule.scenarioParameters).includes('utcome'), false);
    }
    assert.equal(safe.summary.incident, null);
    assert.ok(unsafe.summary.incident.sequence >= 1);
    const unsafeRecords = unsafe.records.map((line) => JSON.parse(line));
    const last = unsafeRecords[unsafeRecords.length - 1];
    assert.ok(last.metadata.sequence <= unsafe.summary.incident.sequence, 'rows stop at the first incident');
    for (const record of unsafeRecords) {
        const distance = unsafe.summary.incident.sequence - record.metadata.sequence;
        assert.equal(record.labels.transitionsToIncident, distance);
        for (const horizon of corpus.HORIZONS) {
            assert.equal(record.labels.horizons[String(horizon)], distance < horizon);
        }
        assert.equal(record.labels.sloViolationWithinKTransitions, record.labels.horizons['5']);
    }
    for (const record of safe.records.map((line) => JSON.parse(line))) {
        assert.equal(record.labels.transitionsToIncident, null);
        assert.ok(Object.values(record.labels.horizons).every((value) => value === false));
    }
});

test('horizon labels K=1/5/10/20 are exact functions of distance to the first incident', () => {
    assert.deepEqual(corpus.horizonLabels(10, 10), { 1: true, 5: true, 10: true, 20: true });
    assert.deepEqual(corpus.horizonLabels(6, 10), { 1: false, 5: true, 10: true, 20: true });
    assert.deepEqual(corpus.horizonLabels(1, 10), { 1: false, 5: false, 10: true, 20: true });
    assert.deepEqual(corpus.horizonLabels(1, 30), { 1: false, 5: false, 10: false, 20: false });
    assert.deepEqual(corpus.horizonLabels(11, 10), { 1: false, 5: false, 10: false, 20: false });
    assert.deepEqual(corpus.horizonLabels(4, null), { 1: false, 5: false, 10: false, 20: false });
});

test('rows carry no future state and model inputs ignore labels, metadata, and outcome fields', async () => {
    const result = await firstOf('unsafe');
    const record = JSON.parse(result.records[0]);
    assert.deepEqual(Object.keys(record).sort(), ['action', 'datasetSchemaVersion', 'labels', 'metadata', 'recordId',
        'scenarioId', 'split', 'state', 'topologyId', 'trajectoryId']);
    assert.ok(!('nextState' in record));
    assert.ok(!('id' in record.action) && !('atMs' in record.action));
    assert.equal(record.metadata.nextStateDigest.length, 32);
    const mutated = JSON.parse(result.records[0]);
    mutated.labels.sloViolationWithinKTransitions = !record.labels.sloViolationWithinKTransitions;
    mutated.labels.horizons = { 1: true, 5: true, 10: true, 20: true };
    mutated.metadata.trajectoryOutcome = 'flipped';
    mutated.metadata.placementKind = 'other';
    assert.deepEqual(modelInput(record), modelInput(mutated));
    assert.deepEqual(extractRiskFeatures(record, record.action), extractRiskFeatures(mutated, mutated.action));
    const serialized = JSON.stringify(record.state);
    for (const token of ['split', 'trajectoryOutcome', 'placementKind', 'scenarioFamily', 'topologyLabel']) {
        assert.ok(!serialized.includes(`"${token}"`), `state carries ${token}`);
    }
});

test('checkpoint selection is deterministic, outcome-blind, and keeps every exogenous decision', () => {
    const kinds = ['tick', 'exogenous', 'timer', 'tick', 'tick', 'exogenous', 'timer', 'timer', 'tick'];
    const meaningful = [false, false, true, false, false, false, false, true, false];
    const policy = corpus.DEFAULT_CHECKPOINT_POLICY;
    const first = corpus.selectCheckpoints(4242, kinds, meaningful, policy);
    const second = corpus.selectCheckpoints(4242, kinds, meaningful, policy);
    assert.deepEqual(first, second);
    kinds.forEach((kind, index) => {
        if (kind === 'exogenous') assert.equal(first[index], 'exogenous');
        if (meaningful[index] && kind !== 'exogenous') assert.equal(first[index], 'state-change');
    });
    assert.equal(corpus.checkpointKind('cloud.fault.node-crash'), 'exogenous');
    assert.equal(corpus.checkpointKind('cloud.controller.deployment'), 'tick');
    assert.equal(corpus.checkpointKind('cloud.kubelet.pod-ready'), 'timer');
});

test('nuisance features and the ShortcutProbe are blind to state, placement, outcome, and labels', async () => {
    const result = await firstOf('unsafe');
    const summary = result.summary;
    const forbidden = ['placement', 'state', 'outcome', 'incident', 'failure', 'violation', 'label', 'graph', 'edge'];
    for (const name of NUISANCE_FEATURE_NAMES) {
        for (const token of forbidden) assert.ok(!name.toLowerCase().includes(token), `${name} leaks ${token}`);
    }
    for (const name of probeFeatureNames('transition')) {
        for (const token of forbidden) assert.ok(!name.toLowerCase().includes(token), `${name} leaks ${token}`);
    }
    const altered = {
        ...summary,
        outcome: 'safe',
        incident: null,
        difficulty: null,
        placementKind: 'balanced',
        placementConcentration: 0.1,
        replayFingerprint: 'x',
    };
    assert.deepEqual(nuisanceVector(altered), nuisanceVector(summary));
    assert.deepEqual(trajectoryProbeVector(altered), trajectoryProbeVector(summary));
    assert.deepEqual(transitionProbeVector(altered, { sequence: 3, atMs: 400 }),
        transitionProbeVector(summary, { sequence: 3, atMs: 400 }));
    const probe = new ShortcutProbe({ featureNames: probeFeatureNames('trajectory') });
    assert.ok(!('state' in probe) && !('graph' in probe));
});

test('label permutation genuinely shuffles training labels while preserving their multiset', () => {
    const labels = Array.from({ length: 200 }, (_, index) => index % 7 === 0);
    const shuffled = shuffledLabels(labels, 1337);
    assert.equal(shuffled.length, labels.length);
    assert.equal(shuffled.filter(Boolean).length, labels.filter(Boolean).length);
    assert.notDeepEqual(shuffled, labels);
    assert.deepEqual(shuffledLabels(labels, 1337), shuffled);
    assert.notDeepEqual(shuffledLabels(labels, 2027), shuffled);
});

test('counterfactual pair members share the exogenous schedule and differ only in the declared intervention', async () => {
    const first = await corpus.executeCounterfactualPair(0, {});
    const second = await corpus.executeCounterfactualPair(0, {});
    assert.deepEqual(first.summary, second.summary);
    assert.equal(first.lines.join('\n'), second.lines.join('\n'));
    const records = first.lines.map((line) => JSON.parse(line));
    const [control, treated] = records;
    assert.equal(control.arm, 'control');
    assert.equal(treated.arm, 'treated');
    assert.equal(control.sharedExogenousScheduleDigest, treated.sharedExogenousScheduleDigest);
    assert.equal(first.summary.sharedExogenousScheduleDigest, first.summary.executedScheduleDigest);
    assert.deepEqual(control.schedule.actions, treated.schedule.actions);
    assert.equal(control.schedule.seed, treated.schedule.seed);
    assert.equal(control.schedule.runtime, treated.schedule.runtime);
    // Everything except the intervention itself and its labels must agree.
    const strip = (schedule) => ({
        ...schedule.scenarioParameters,
        placement: null,
        pair: null,
        generator: { ...schedule.scenarioParameters.generator, placementKind: null },
    });
    assert.deepEqual(strip(control.schedule), strip(treated.schedule));
    assert.notDeepEqual(control.schedule.scenarioParameters.placement, treated.schedule.scenarioParameters.placement);
    for (const type of first.summary.graphStructuralDelta.differingEdgeTypes) {
        assert.ok(['RUNS_ON', 'LOCATED_IN'].includes(type), `unexpected structural delta ${type}`);
    }
    assert.ok(['same', 'safe->unsafe', 'unsafe->safe', 'invalid'].includes(first.summary.outcomeChange));
    assert.equal(first.summary.controlOutcome, control.labels.trajectoryUnsafe ? 'unsafe' : 'safe');
    assert.equal(first.summary.treatedOutcome, treated.labels.trajectoryUnsafe ? 'unsafe' : 'safe');
});

test('bounded pipeline: raw and matched distributions, deterministic matching, stable hashes, gates', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudproof-causal-'));
    const again = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudproof-causal-again-'));
    try {
        const options = {
            trajectories: 80,
            seedStart: 61000,
            pairs: 12,
            workers: 1,
            generatorCommitSha: 'test-commit',
            budgets: [2, 4, 8],
            minimumTrajectories: 80,
            minimumMatchedPairs: 1,
            minimumDiscordantPairs: 0,
        };
        const first = await generateCausalCorpus({ ...options, outputDirectory: directory });
        const second = await generateCausalCorpus({ ...options, outputDirectory: again });
        const manifest = first.manifest;
        assert.equal(manifest.kind, 'cloudproof.causal-corpus-manifest');
        assert.equal(manifest.schemaVersion, corpus.CAUSAL_DATASET_SCHEMA_VERSION);
        assert.equal(manifest.generator.outcomeBlind, true);
        assert.equal(manifest.counts.pool, 80);
        assert.equal(manifest.counts.poolSafe + manifest.counts.poolUnsafe, 80);
        assert.equal(manifest.counts.selectedSafe, manifest.counts.selectedUnsafe);
        assert.ok(manifest.counts.selectedTrajectories <= 80);
        assert.equal(manifest.matching.deterministic, true);
        assert.equal(manifest.replay.fingerprintMismatches, 0);
        assert.equal(manifest.replay.phaseOneArtifact.byteIdentical, true);
        for (const [name, file] of Object.entries(manifest.files)) {
            assert.equal(file.sha256.length, 64, name);
            assert.equal(file.sha256, second.manifest.files[name].sha256, `${name} hash drifted between runs`);
        }
        const rows = fs.readFileSync(path.join(directory, 'transitions-train.jsonl'), 'utf8').split('\n').filter(Boolean);
        const parsed = rows.map((line) => JSON.parse(line));
        assert.ok(parsed.every((row) => row.split === 'train'));
        assert.ok(parsed.every((row) => row.metadata.rawTransitionCount >= row.metadata.researchTransitionCount));
        const evaluation = evaluateCausalCorpus(first, { budgets: [2, 4, 8], iterations: 20 });
        assert.equal(evaluation.splitIntegrity.ok, true);
        assert.equal(evaluation.labelPermutation.trials.length, 5);
        assert.ok(Object.keys(evaluation.transitionMetrics).length === 4);
        const acceptance = evaluateCausalAcceptance(first, evaluation, options);
        for (const gate of ['outcomeBlindGeneration', 'labelsFromDeterministicExecution', 'matchingDeterministic',
            'splitIntegrity', 'topologyHeldOutSplits', 'explicitOodSplit', 'freshHoldouts', 'noFutureStateInRows',
            'noFamilyIdentifiersInInputs', 'manifestHashesPresent', 'phaseOneReplayByteIdentical',
            'pairLabelsSimulatorDerived']) {
            assert.equal(acceptance.gates[gate], true, gate);
        }
        writeAcceptedManifest(first, evaluation, acceptance);
        for (const name of ['manifest.json', 'evaluation.json', 'sanity-report.json', 'nuisance-report.json']) {
            assert.ok(fs.existsSync(path.join(directory, name)), name);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(again, { recursive: true, force: true });
    }
});

test('split integrity rejects a row, trajectory, or pair that crosses a holdout boundary', () => {
    const catalog = TOPOLOGY_CATALOG_V2;
    const summaries = [
        { trajectoryId: 't1', split: 'train' },
        { trajectoryId: 't2', split: 'test' },
    ];
    const good = splitIntegrity({
        summaries,
        examplesBySplit: { train: [{ trajectoryId: 't1', split: 'train' }], validation: [], test: [{ trajectoryId: 't2', split: 'test' }], ood: [] },
        pairSummaries: [{ split: 'test', topologyId: catalog.find((entry) => entry.split === 'test').topologyId }],
        catalog,
    });
    assert.equal(good.ok, true);
    const leaked = splitIntegrity({
        summaries,
        examplesBySplit: { train: [{ trajectoryId: 't2', split: 'train' }], validation: [], test: [], ood: [] },
        pairSummaries: [],
        catalog,
    });
    assert.equal(leaked.ok, false);
    const crossPair = splitIntegrity({
        summaries,
        examplesBySplit: { train: [], validation: [], test: [], ood: [] },
        pairSummaries: [{ split: 'train', topologyId: catalog.find((entry) => entry.split === 'ood').topologyId }],
        catalog,
    });
    assert.equal(crossPair.ok, false);
});

test('post-hoc matching is deterministic, 1:1, and never pairs across a split', () => {
    const summaries = [];
    for (let index = 0; index < 40; index += 1) {
        const split = index % 2 === 0 ? 'train' : 'test';
        summaries.push({
            trajectoryId: `t${String(index).padStart(3, '0')}`,
            split,
            topologyId: `topo-${split}`,
            runtime: 'correct',
            trafficRegime: 'normal',
            outcome: index % 3 === 0 ? 'unsafe' : 'safe',
            actions: 60 + (index % 5) * 10,
            transitions: 80 + index,
            virtualRuntimeMs: 5000 + index * 10,
            faultCount: index % 3,
            faults: { 'node-crash': index % 2 },
            operations: { 'roll-out': index % 2 },
            operationCount: 2,
        });
    }
    const first = matchTrajectories(summaries);
    const second = matchTrajectories(summaries);
    assert.deepEqual(first.pairs, second.pairs);
    const byId = new Map(summaries.map((summary) => [summary.trajectoryId, summary]));
    const seen = new Set();
    for (const pair of first.pairs) {
        assert.equal(byId.get(pair.unsafeTrajectoryId).outcome, 'unsafe');
        assert.equal(byId.get(pair.safeTrajectoryId).outcome, 'safe');
        assert.equal(byId.get(pair.unsafeTrajectoryId).split, byId.get(pair.safeTrajectoryId).split);
        assert.ok(!seen.has(pair.safeTrajectoryId) && !seen.has(pair.unsafeTrajectoryId));
        seen.add(pair.safeTrajectoryId);
        seen.add(pair.unsafeTrajectoryId);
    }
    assert.equal(first.counts.selectedTrajectories, 2 * first.pairs.length);
});

test('Phase I promoted counterexample still replays byte-identically after the placement hook', async () => {
    const replay = await replayCloudArtifact(path.join(__dirname, '..', 'artifacts', 'cloudproof', 'failure-1337.json'));
    assert.equal(replay.sameFailure, true);
    assert.equal(replay.byteIdentical, true);
});

test('Phase II-B.1 audit fixtures stay readable and the Phase II-A corpus provenance is untouched', () => {
    const root = path.join(__dirname, '..');
    const audit = JSON.parse(fs.readFileSync(path.join(root, 'CLOUDPROOF-PHASE-II-B1-AUDIT.json'), 'utf8'));
    const bounded = JSON.parse(fs.readFileSync(path.join(root, 'CLOUDPROOF-PHASE-II-B-BOUNDED-RESULTS.json'), 'utf8'));
    assert.ok(audit && typeof audit === 'object');
    assert.ok(bounded && typeof bounded === 'object');
    const legacy = require('./cloud-corpus');
    assert.equal(typeof legacy.generateResearchCorpus, 'function');
    assert.equal(legacy.scenarioDescriptor(1, 20001, TOPOLOGY_CATALOG[0], 0).intendedOutcome, 'unsafe');
    assert.deepEqual(TOPOLOGY_CATALOG.filter((entry) => entry.split === 'test').map((entry) => entry.label), ['K', 'L', 'M']);
    assert.deepEqual(TOPOLOGY_CATALOG.filter((entry) => entry.split === 'ood').map((entry) => entry.label),
        ['OOD-A', 'OOD-B', 'OOD-C', 'OOD-D']);
});
