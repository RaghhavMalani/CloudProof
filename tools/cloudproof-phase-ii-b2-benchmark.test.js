'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    EDGE_MODES,
    compactCoverage,
    parseArgs,
    parseScorer,
    relationalFlatIdentity,
    replayTrajectory,
    uniqueRequests,
    verifyFrozenFiles,
} = require('./cloudproof-phase-ii-b2-benchmark');
const { executeCausalTrajectory, regenerateSchedule } = require('../sim/cloud-causal-corpus');
const { riskScorerKey } = require('../packages/cloudproof/gnn-risk-scorer');

const RELATIONAL_FIXTURE = path.join(__dirname, '..', 'artifacts', 'cloudproof', 'datasets', 'relational-pairs-95000.jsonl');

test('scorer specs carry a model directory, an edge mode and a seed; reserved names are rejected', () => {
    assert.deepEqual(parseScorer('gnn=artifacts/models/gnn-full-k5'), {
        name: 'gnn', modelDir: 'artifacts/models/gnn-full-k5', edgeMode: 'full', edgeSeed: 1729,
    });
    assert.deepEqual(parseScorer('gnnRewiredEdges=D:\\models\\gnn:rewired-edges:2729'), {
        name: 'gnnRewiredEdges', modelDir: 'D:\\models\\gnn', edgeMode: 'rewired-edges', edgeSeed: 2729,
    });
    assert.throws(() => parseScorer('logistic=some/dir'), /reserved/);
    assert.throws(() => parseScorer('Gnn=some/dir'), /camelCase/);
    assert.throws(() => parseScorer('gnn=dir:no-edges:x'), /edge seed/);
    const options = parseArgs(['--scorer', 'gnn=a', '--scorer', 'pooledMlp=b:full', '--budgets', '10,50', '--max-schedules', '7']);
    assert.deepEqual(options.budgets, [10, 50]);
    assert.equal(options.maxSchedules, 7);
    assert.deepEqual(options.scorers.map((scorer) => scorer.name), ['gnn', 'pooledMlp']);
    assert.throws(() => parseArgs(['--scorer', 'gnn=a', '--scorer', 'gnn=b']), /unique/);
    assert.throws(() => parseArgs(['--budgets', '0']), /positive/);
    assert.ok(EDGE_MODES.includes('rewired-edges'));
});

test('a replayed held-out trajectory rebuilds the corpus pipeline candidate and rejects drift', async () => {
    const executed = await executeCausalTrajectory(3, {}, true);
    const expected = executed.candidate;
    // The pool keeps the executable schedule from trajectories.jsonl; the
    // pipeline's regenerate path yields the same object for the same index.
    const item = {
        trajectoryId: executed.summary.trajectoryId,
        split: executed.summary.split,
        topologyId: executed.summary.topologyId,
        tier: executed.summary.difficulty?.tier ?? null,
        outcome: executed.summary.outcome,
        violationClass: executed.summary.incident?.violationClass || null,
        schedule: regenerateSchedule(3, {}).schedule,
        replayFingerprint: executed.summary.replayFingerprint,
    };
    const candidate = await replayTrajectory(item);
    assert.deepEqual(candidate.schedule, expected.schedule);
    assert.deepEqual(candidate.initialState, expected.initialState);
    assert.deepEqual(candidate.result, expected.result);
    assert.equal(candidate.scenarioId, expected.scenarioId);
    assert.equal(candidate.split, expected.split);
    assert.equal(candidate.tier, expected.tier);
    assert.ok(candidate.verificationWallTimeMs > 0);
    await assert.rejects(replayTrajectory({ ...item, replayFingerprint: 'tampered' }), /replay fingerprint changed/);
    await assert.rejects(replayTrajectory({ ...item, outcome: item.outcome === 'safe' ? 'unsafe' : 'safe' }), /replay outcome changed/);
});

test('inference requests are deduplicated by the stable state/action key', async () => {
    const executed = await executeCausalTrajectory(5, {}, true);
    const candidate = executed.candidate;
    const requests = uniqueRequests([candidate, candidate]);
    const keys = new Set(candidate.schedule.actions.map((action) => riskScorerKey(candidate.initialState, action)));
    assert.equal(requests.size, keys.size);
    assert.ok(requests.size < candidate.schedule.actions.length * 2);
    for (const [key, request] of requests) {
        assert.equal(key, riskScorerKey(request.state, request.action));
        assert.equal(request.action.atMs, undefined);
        assert.equal(request.action.id, undefined);
    }
});

test('compact coverage keeps every metric and replaces only the signature list with its digest', () => {
    const crypto = require('node:crypto');
    const signatures = ['b|x', 'a|y'];
    const full = {
        methods: {
            gnn: { budgets: { 10: { failuresFound: 4, controllerStateCoverage: {
                target: { covered: 3 }, controllerStates: { count: 2, signatures },
            } } } },
        },
        pool: { schedules: 7 },
    };
    const compact = compactCoverage(full);
    const states = compact.methods.gnn.budgets['10'].controllerStateCoverage.controllerStates;
    assert.equal(states.count, 2);
    assert.equal(states.signatures, undefined);
    assert.equal(states.signaturesSha256, crypto.createHash('sha256').update(JSON.stringify(signatures)).digest('hex'));
    assert.equal(compact.methods.gnn.budgets['10'].failuresFound, 4);
    assert.deepEqual(compact.pool, full.pool);
    assert.deepEqual(full.methods.gnn.budgets['10'].controllerStateCoverage.controllerStates.signatures, signatures);
});

test('flat risk features are identical for every relational-only pair in the committed fixture', { skip: !fs.existsSync(RELATIONAL_FIXTURE) }, async () => {
    const identity = await relationalFlatIdentity(RELATIONAL_FIXTURE);
    assert.ok(identity.validRelationalPairs >= 2);
    assert.equal(identity.flatFeaturesIdentical, identity.validRelationalPairs);
});

test('frozen file verification recomputes SHA-256 and rejects any drift', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-ii-b2-freeze-'));
    try {
        const corpus = path.join(directory, 'causal-corpus-test');
        fs.mkdirSync(corpus);
        fs.writeFileSync(path.join(corpus, 'trajectories.jsonl'), '{"trajectoryId":"t"}\n');
        const crypto = require('node:crypto');
        const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(corpus, 'trajectories.jsonl'))).digest('hex');
        const files = { 'trajectories.jsonl': { sha256: digest, bytes: fs.statSync(path.join(corpus, 'trajectories.jsonl')).size } };
        fs.writeFileSync(path.join(corpus, 'manifest.json'), JSON.stringify({ files }));
        const freeze = path.join(directory, 'freeze.json');
        fs.writeFileSync(freeze, JSON.stringify({
            kind: 'cloudproof.causal-corpus-freeze', corpus: 'causal-corpus-test', acceptance: { passed: true },
            generator: { commitSha: 'abc' }, files,
        }));
        const verified = await verifyFrozenFiles(corpus, freeze, ['trajectories.jsonl']);
        assert.equal(verified.files['trajectories.jsonl'], digest);
        assert.equal(verified.generatorCommitSha, 'abc');
        fs.appendFileSync(path.join(corpus, 'trajectories.jsonl'), '\n');
        await assert.rejects(verifyFrozenFiles(corpus, freeze, ['trajectories.jsonl']), /SHA-256 mismatch/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
