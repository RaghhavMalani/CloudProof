'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { infrastructureGraph } = require('./graph');
const { OfflineGnnRiskScorer, riskScorerKey } = require('./gnn-risk-scorer');
const { evaluateSchedulePrioritizers } = require('./schedule-evaluation');
const { createCloudState } = require('./state');

function graph() {
    return infrastructureGraph(createCloudState({
        seed: 1,
        topology: {
            initialReplicas: 3,
            zones: 2,
            maxSurge: 1,
            maxUnavailable: 0,
            pdbMinAvailable: 2,
            hpaMinReplicas: 2,
            hpaMaxReplicas: 6,
            hpaTarget: 60,
            serviceMinimumReady: 2,
            nodeCpuMillicores: 4000,
            nodeMemoryMb: 8192,
            podCpuMillicores: 500,
            podMemoryMb: 512,
        },
    }));
}

test('offline GNN scorer exposes mean risk and ensemble uncertainty', () => {
    const state = graph();
    const action = { type: 'cloud.action.scale', replicas: 4 };
    const scorer = new OfflineGnnRiskScorer([{
        key: riskScorerKey(state, action), risk: 0.83, uncertainty: 0.17,
    }]);
    assert.deepEqual(scorer.scoreWithUncertainty(state, action), { risk: 0.83, uncertainty: 0.17 });
    assert.equal(scorer.score(state, action), 0.83);
});

test('fixed-budget evaluation adds GNN without changing baseline methods', () => {
    const state = graph();
    const action = { type: 'cloud.action.scale', replicas: 4 };
    const candidate = (scenarioId, ok) => ({
        scenarioId,
        initialState: state,
        schedule: { actions: [action] },
        result: { ok, failure: ok ? null : { violationClass: 'TEST' }, schedule: { actions: [action] },
            graphTransitions: [] },
    });
    const candidates = [candidate('safe', true), candidate('unsafe', false)];
    const baseline = { score: () => 0.5 };
    const evaluation = evaluateSchedulePrioritizers(candidates, baseline, {
        budgets: [1, 2], additionalScorers: { gnn: { score: () => 0.8 } },
    });
    assert.deepEqual(Object.keys(evaluation.methods), [
        'coverageGuided', 'gnn', 'heuristic', 'logistic', 'random',
    ]);
    assert.equal(evaluation.methods.gnn.budgets['2'].evaluatedSchedules, 2);
});
