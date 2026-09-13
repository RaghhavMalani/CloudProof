'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { modelInput, extractRiskFeatures } = require('../packages/cloudproof/transition-dataset');
const { TOPOLOGY_CATALOG, normalizeTopology } = require('../packages/cloudproof/topology');
const { runCloudSchedule } = require('./cloud-runtime');
const {
    evaluateAcceptanceGates,
    evaluateResearchCorpus,
    generateResearchCorpus,
    materializeResearchSchedule,
    scenarioDescriptor,
} = require('./cloud-corpus');

test('research topology splits are disjoint and reserve 8-12 replicas for OOD', () => {
    const labels = (split) => TOPOLOGY_CATALOG.filter((entry) => entry.split === split)
        .map((entry) => entry.label);
    assert.deepEqual(labels('train'), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    assert.deepEqual(labels('validation'), ['I', 'J']);
    assert.deepEqual(labels('test'), ['K', 'L', 'M']);
    assert.ok(TOPOLOGY_CATALOG.filter((entry) => entry.split === 'train')
        .every((entry) => entry.topology.initialReplicas <= 6));
    assert.ok(TOPOLOGY_CATALOG.filter((entry) => entry.split === 'ood')
        .every((entry) => entry.topology.initialReplicas >= 8));
    assert.equal(new Set(TOPOLOGY_CATALOG.map((entry) => entry.topologyId)).size,
        TOPOLOGY_CATALOG.length);
    const partial = normalizeTopology({ initialReplicas: 3, zones: 2 });
    assert.ok(partial.hpaMinReplicas <= partial.initialReplicas);
    assert.ok(partial.pdbMinAvailable <= partial.initialReplicas);
});

test('parameterized research schedules replay byte-identically on unseen topology', async () => {
    const entry = TOPOLOGY_CATALOG.find((candidate) => candidate.label === 'OOD-D');
    const descriptor = scenarioDescriptor(1, 41001, entry, 16);
    const firstSchedule = materializeResearchSchedule(descriptor, entry);
    const secondSchedule = materializeResearchSchedule(descriptor, entry);
    assert.deepEqual(firstSchedule, secondSchedule);
    const first = await runCloudSchedule(firstSchedule, { mutant: descriptor.runtime });
    const second = await runCloudSchedule(secondSchedule, { mutant: descriptor.runtime });
    assert.equal(first.replayFingerprint, second.replayFingerprint);
    assert.deepEqual(first.graphTransitions, second.graphTransitions);
    assert.equal(first.finalState.resources.zones.length, 3);
    assert.equal(first.graphTransitions[0].state.nodes.filter((node) => node.type === 'Pod').length, 12);
});

test('features cannot observe next state or future labels', async () => {
    const entry = TOPOLOGY_CATALOG[0];
    const descriptor = scenarioDescriptor(1, 42001, entry, 0);
    const result = await runCloudSchedule(materializeResearchSchedule(descriptor, entry),
        { mutant: descriptor.runtime });
    const row = result.graphTransitions[0];
    const changedFuture = JSON.parse(JSON.stringify(row));
    changedFuture.nextState.nodes = [];
    changedFuture.labels.sloViolationWithinKTransitions = !row.labels.sloViolationWithinKTransitions;
    assert.deepEqual(modelInput(row), modelInput(changedFuture));
    assert.deepEqual(extractRiskFeatures(row, row.action),
        extractRiskFeatures(changedFuture, changedFuture.action));
});

test('corpus generation, manifest, baselines, and verification-budget gates compose', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudproof-research-'));
    try {
        const corpus = await generateResearchCorpus({
            simulations: 34,
            seedStart: 43000,
            outputDirectory: directory,
            generatorCommitSha: 'test-commit',
        });
        assert.deepEqual(corpus.manifest.balance, { absoluteDifference: 0, safe: 17, unsafe: 17 });
        assert.equal(corpus.manifest.generator.commitSha, 'test-commit');
        assert.equal(corpus.manifest.splitPolicy, 'topology-holdout-v1');
        assert.ok(corpus.manifest.transitions > 34);
        for (const split of ['train', 'validation', 'test', 'ood']) {
            assert.ok(corpus.manifest.distributions[split].schedules > 0);
            assert.ok(corpus.manifest.files[`transitions-${split}.jsonl`].sha256.length === 64);
            const first = JSON.parse(fs.readFileSync(path.join(directory,
                `transitions-${split}.jsonl`), 'utf8').split('\n')[0]);
            assert.equal(first.split, split);
            assert.equal(typeof first.scenarioId, 'string');
            assert.equal(typeof first.topologyId, 'string');
            assert.equal(first.metadata.featureBoundary, 'state-and-candidate-action-only');
        }
        const evaluation = evaluateResearchCorpus(corpus, { iterations: 10, budgets: [2, 4, 8] });
        for (const metrics of Object.values(evaluation.transitionMetrics)) {
            for (const method of ['random', 'heuristic', 'logistic']) {
                assert.equal(typeof metrics[method].brierScore, 'number');
                assert.equal(typeof metrics[method].expectedCalibrationError, 'number');
            }
        }
        for (const method of ['random', 'coverageGuided', 'heuristic', 'logistic']) {
            const budget = evaluation.schedulePrioritization.methods[method].budgets['8'];
            assert.equal(typeof budget.failureRecall, 'number');
            assert.equal(typeof budget.controllerStateCoverage.target.ratio, 'number');
            assert.equal(typeof budget.verificationWallTimeMs, 'number');
        }
        const acceptance = evaluateAcceptanceGates(corpus, evaluation, {
            minimumSimulations: 34,
            budgets: [2, 4, 8],
        });
        assert.equal(acceptance.passed, true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
