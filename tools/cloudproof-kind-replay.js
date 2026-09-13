#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { evaluateCloudInvariants, sameCloudFailure } = require('../packages/cloudproof/invariants');
const { POD_PHASE } = require('../packages/cloudproof/resources');
const { createFlagshipState, recomputeObserved } = require('../packages/cloudproof/state');
const { CLOUD_ACTION, CLOUD_FAULT } = require('../sim/cloud-actions');

const ROOT = path.resolve(__dirname, '..');
const NAMESPACE = 'cloudproof';

function kubectl(args, { allowFailure = false, capture = true } = {}) {
    const result = spawnSync('kubectl', args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !allowFailure) {
        throw new Error(`kubectl ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return result;
}

function readJson(args) {
    const result = kubectl([...args, '-o', 'json']);
    return JSON.parse(result.stdout);
}

function readyReplicas() {
    const deployment = readJson(['-n', NAMESPACE, 'get', 'deployment', 'api']);
    return deployment.status?.readyReplicas || 0;
}

function discoverNodeMap() {
    const nodes = readJson(['get', 'nodes']).items.filter((node) => (
        node.metadata.labels['node-role.kubernetes.io/control-plane'] === undefined
    )).sort((left, right) => left.metadata.name.localeCompare(right.metadata.name));
    const mapping = {};
    const logical = ['node-a', 'node-b', 'node-c'];
    for (const node of nodes) {
        const label = node.metadata.labels['cloudproof.io/node'];
        if (logical.includes(label)) mapping[label] = node.metadata.name;
    }
    const unassigned = nodes.filter((node) => !Object.values(mapping).includes(node.metadata.name));
    logical.filter((name) => !mapping[name]).forEach((name, index) => {
        if (unassigned[index]) mapping[name] = unassigned[index].metadata.name;
    });
    if (Object.keys(mapping).length < 3) throw new Error('CloudProof replay requires three worker nodes');
    return mapping;
}

function observeFailure(minReady, expectedFailure) {
    const state = createFlagshipState({ seed: 0 });
    const deployment = state.resources.deployments[0];
    deployment.rollout.active = expectedFailure.invariant === 'cloud.deployment.rollout-availability';
    deployment.rollout.oldPodsTerminated = deployment.rollout.active ? 1 : 0;
    const ordered = state.resources.pods.slice().sort((left, right) => left.id.localeCompare(right.id));
    ordered.forEach((pod, index) => {
        pod.phase = index < minReady ? POD_PHASE.READY : POD_PHASE.FAILED;
        pod.ready = index < minReady;
    });
    state.resources.services[0].observed.endpointPodIds = ordered.slice(0, minReady).map((pod) => pod.id);
    recomputeObserved(state);
    return evaluateCloudInvariants(state).failure;
}

function patchRollout(version) {
    const patch = JSON.stringify({ spec: { template: { metadata: { annotations: {
        'cloudproof.io/version': version,
    } } } } });
    kubectl(['-n', NAMESPACE, 'patch', 'deployment', 'api', '--type=merge', '-p', patch]);
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainAndObserve(nodeName, observations) {
    const child = spawn('kubectl', [
        'drain', nodeName,
        '--ignore-daemonsets',
        '--delete-emptydir-data',
        '--timeout=12s',
    ], { cwd: ROOT, stdio: 'ignore' });
    let exited = false;
    child.once('exit', () => { exited = true; });
    for (let attempt = 0; attempt < 48 && !exited; attempt += 1) {
        await wait(250);
        try { observations.push(readyReplicas()); } catch (_) { /* API can briefly race pod deletion. */ }
    }
    if (!exited) child.kill('SIGTERM');
}

async function replayOnKind(artifactFile, options = {}) {
    const artifact = JSON.parse(fs.readFileSync(path.resolve(artifactFile), 'utf8'));
    if (artifact.kind !== 'cloudproof.counterexample') throw new TypeError('not a CloudProof artifact');
    const expected = artifact.expectedFailure;
    if (options.dryRun) {
        return {
            predicted: { minReadyReplicas: artifact.result.metrics.minReadyReplicas,
                failureClass: expected.violationClass },
            commands: artifact.schedule.actions.map((action) => action.type),
        };
    }

    kubectl(['cluster-info']);
    kubectl(['apply', '-f', path.join(ROOT, 'k8s', 'cloudproof', 'flagship.yaml')], { capture: false });
    kubectl(['apply', '-f', path.join(ROOT, 'k8s', 'cloudproof', 'loadgen.yaml')], { capture: false });
    kubectl(['-n', NAMESPACE, 'rollout', 'status', 'deployment/api', '--timeout=180s'], { capture: false });
    const nodes = discoverNodeMap();
    const observations = [readyReplicas()];
    const cordoned = new Set();
    try {
        for (const action of artifact.schedule.actions) {
            if (action.type === CLOUD_ACTION.ROLL_OUT || action.type === CLOUD_ACTION.ROLL_BACK) {
                patchRollout(action.version || 'v42');
            } else if (action.type === CLOUD_ACTION.SCALE) {
                kubectl(['-n', NAMESPACE, 'scale', 'deployment/api', `--replicas=${action.replicas}`]);
            } else if ([CLOUD_ACTION.DRAIN_NODE, CLOUD_FAULT.NODE_DRAIN].includes(action.type)) {
                const logical = String(action.nodeId || 'node-b').replace(/^node\//, '');
                const actual = nodes[logical];
                cordoned.add(actual);
                await drainAndObserve(actual, observations);
            } else if (action.type === CLOUD_FAULT.NODE_CRASH) {
                const logical = String(action.nodeId || 'node-a').replace(/^node\//, '');
                const actual = nodes[logical];
                cordoned.add(actual);
                kubectl(['cordon', actual], { allowFailure: true });
                kubectl(['-n', NAMESPACE, 'delete', 'pod', '--field-selector', `spec.nodeName=${actual}`,
                    '--grace-period=0', '--force'], { allowFailure: true });
            } else if (action.type === CLOUD_ACTION.RECOVER_NODE) {
                const logical = String(action.nodeId || 'node-a').replace(/^node\//, '');
                kubectl(['uncordon', nodes[logical]], { allowFailure: true });
                cordoned.delete(nodes[logical]);
            } else if (action.type === CLOUD_ACTION.ADVANCE_TIME) {
                await wait(Math.min(3000, Math.max(100, action.ms || 0)));
            }
            try { observations.push(readyReplicas()); } catch (_) { /* keep the previous sample */ }
        }
    } finally {
        for (const node of cordoned) kubectl(['uncordon', node], { allowFailure: true });
    }
    const observedMin = Math.min(...observations);
    const observedFailure = observeFailure(observedMin, expected);
    const observedResult = { failure: observedFailure };
    const confirmed = Boolean(observedFailure)
        && observedFailure.violationClass === expected.violationClass
        && sameCloudFailure(expected, observedResult);
    return {
        predicted: {
            minReadyReplicas: artifact.result.metrics.minReadyReplicas,
            failureClass: expected.violationClass,
        },
        observed: { minReadyReplicas: observedMin, failureClass: observedFailure?.violationClass || null },
        confirmed,
    };
}

function print(result) {
    process.stdout.write([
        'SIMULATION', '',
        `Predicted min ready replicas = ${result.predicted.minReadyReplicas}`,
        `Predicted violation = ${result.predicted.failureClass}`, '',
        'KIND', '',
        `Observed min ready replicas = ${result.observed?.minReadyReplicas ?? 'dry-run'}`,
        `Observed violation = ${result.observed?.failureClass ?? 'dry-run'}`, '',
        `SIM-TO-REAL: ${result.confirmed ? 'CONFIRMED' : result.observed ? 'MISMATCH' : 'DRY-RUN'}`,
    ].join('\n') + '\n');
}

async function main(argv = process.argv.slice(2)) {
    const artifact = argv.find((value) => !value.startsWith('--'));
    if (!artifact) throw new TypeError('usage: node tools/cloudproof-kind-replay.js <artifact> [--dry-run]');
    const result = await replayOnKind(artifact, { dryRun: argv.includes('--dry-run') });
    print(result);
    if (result.observed && !result.confirmed) process.exitCode = 1;
}

if (require.main === module) void main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});

module.exports = { discoverNodeMap, observeFailure, replayOnKind };
