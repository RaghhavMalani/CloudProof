'use strict';

const { infrastructureGraph } = require('./graph');
const { evaluateCloudInvariants } = require('./invariants');
const { clone, stable } = require('./state');

function latencyBucket(latencyMs) {
    if (latencyMs < 25) return 'UNDER_25_MS';
    if (latencyMs < 100) return '25_TO_99_MS';
    if (latencyMs < 500) return '100_TO_499_MS';
    return '500_MS_OR_MORE';
}

class TransitionTelemetry {
    constructor({ horizonMs = 1000 } = {}) {
        this.horizonMs = horizonMs;
        this.transitions = [];
        this.sequence = 0;
    }

    capture(beforeState, action, afterState, metadata = {}) {
        const evaluated = evaluateCloudInvariants(afterState);
        const service = afterState.resources.services[0];
        const row = stable({
            sequence: ++this.sequence,
            atMs: afterState.clockMs,
            state: infrastructureGraph(beforeState),
            action: clone(action),
            nextState: infrastructureGraph(afterState),
            labels: {
                sloViolationWithin1000ms: false,
                minReadyReplicas: service.observed.endpointPodIds.length,
                latencyBucket: latencyBucket(afterState.traffic.latencyMs),
                failureClass: evaluated.failure?.violationClass || null,
            },
            metadata: clone(metadata),
        });
        this.transitions.push(row);
        return evaluated;
    }

    export() {
        return this.transitions.map((row, index, rows) => {
            const deadline = row.atMs + this.horizonMs;
            const future = rows.slice(index).find((candidate) => (
                candidate.atMs <= deadline && candidate.labels.failureClass !== null
            ));
            return stable({
                ...clone(row),
                labels: {
                    ...row.labels,
                    sloViolationWithin1000ms: Boolean(future),
                    failureClass: future?.labels.failureClass || row.labels.failureClass,
                    minReadyReplicas: Math.min(...rows.slice(index)
                        .filter((candidate) => candidate.atMs <= deadline)
                        .map((candidate) => candidate.labels.minReadyReplicas)),
                },
            });
        });
    }
}

module.exports = { TransitionTelemetry, latencyBucket };
