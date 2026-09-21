#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { infrastructureGraph } = require('../packages/cloudproof/graph');
const { evaluateCloudInvariants } = require('../packages/cloudproof/invariants');
const { recomputeObserved } = require('../packages/cloudproof/state');
const { CloudRuntimeSimulation } = require('../sim/cloud-runtime');

function parseArgs(argv = process.argv.slice(2)) {
    const options = {
        pairs: 250,
        seed: 71000,
        out: path.join('artifacts', 'cloudproof', 'audit', 'topology-counterfactuals.jsonl'),
    };
    for (let index = 0; index < argv.length; index += 1) {
        const name = argv[index];
        const value = argv[index + 1];
        if (value === undefined) throw new TypeError(`missing value for ${name}`);
        if (name === '--pairs') options.pairs = Number(value);
        else if (name === '--seed') options.seed = Number(value);
        else if (name === '--out') options.out = value;
        else throw new TypeError(`unknown option: ${name}`);
        index += 1;
    }
    if (!Number.isInteger(options.pairs) || options.pairs < 100 || options.pairs > 500) {
        throw new TypeError('pairs must be an integer in [100, 500]');
    }
    if (!Number.isInteger(options.seed)) throw new TypeError('seed must be an integer');
    return options;
}

function topology(index) {
    return {
        initialReplicas: 6,
        zones: 3,
        maxSurge: index % 2,
        maxUnavailable: index % 3 === 0 ? 0 : 1,
        pdbMinAvailable: 4,
        hpaMinReplicas: 3,
        hpaMaxReplicas: 12,
        hpaTarget: 55 + (index % 3) * 5,
        serviceMinimumReady: 4,
        nodeCpuMillicores: 4000,
        nodeMemoryMb: 8192,
        podCpuMillicores: 500,
        podMemoryMb: 512,
    };
}

function placePods(simulation, counts, targetZoneIndex) {
    const zones = simulation.state.resources.zones.slice().sort((a, b) => a.id.localeCompare(b.id));
    const orderedZones = [zones[targetZoneIndex], ...zones.filter((_, index) => index !== targetZoneIndex)];
    const nodes = orderedZones.map((zone) => simulation.state.resources.nodes
        .filter((node) => node.zoneId === zone.id).sort((a, b) => a.id.localeCompare(b.id)));
    const pods = simulation.state.resources.pods.slice().sort((a, b) => a.id.localeCompare(b.id));
    let cursor = 0;
    for (let zoneIndex = 0; zoneIndex < counts.length; zoneIndex += 1) {
        for (let local = 0; local < counts[zoneIndex]; local += 1) {
            pods[cursor].nodeId = nodes[zoneIndex][local % nodes[zoneIndex].length].id;
            cursor += 1;
        }
    }
    recomputeObserved(simulation.state);
    return orderedZones[0].id;
}

function graphWithoutPlacement(graph) {
    return {
        ...graph,
        edges: graph.edges.filter((edge) => edge.type !== 'RUNS_ON'),
    };
}

async function variant(pairIndex, seed, placement, expectedUnsafe) {
    const simulation = new CloudRuntimeSimulation({
        seed,
        topology: topology(pairIndex),
        traffic: {
            cpuPercent: 35 + (pairIndex % 3) * 20,
            latencyMs: 12 + (pairIndex % 4) * 7,
            requestsPerSecond: 60 + (pairIndex % 5) * 30,
        },
        horizonTransitions: 1,
    });
    const targetZoneIndex = pairIndex % 3;
    const zoneId = placePods(simulation, placement, targetZoneIndex);
    const action = { id: `counterfactual-${pairIndex}`, type: 'cloud.fault.zone-degraded', zoneId };
    const state = infrastructureGraph(simulation.export());
    await simulation.execute(action);
    const failure = simulation.firstFailure || evaluateCloudInvariants(simulation.export()).failure;
    const unsafe = failure !== null;
    assert.equal(unsafe, expectedUnsafe, `unexpected deterministic truth for pair ${pairIndex}`);
    return { action, state, unsafe, violationClass: failure?.violationClass || null };
}

async function buildPair(pairIndex, seed) {
    const balanced = await variant(pairIndex, seed, [2, 2, 2], false);
    const concentrated = await variant(pairIndex, seed, [4, 1, 1], true);
    assert.deepEqual(balanced.action, concentrated.action);
    assert.deepEqual(graphWithoutPlacement(balanced.state), graphWithoutPlacement(concentrated.state));
    const pairId = `topology-pair-${String(pairIndex).padStart(4, '0')}`;
    return [
        {
            recordId: `${pairId}:balanced`, pairId, variant: 'balanced',
            state: balanced.state, action: balanced.action,
            labels: { sloViolationWithinKTransitions: balanced.unsafe },
            truth: { unsafe: balanced.unsafe, violationClass: balanced.violationClass },
        },
        {
            recordId: `${pairId}:concentrated`, pairId, variant: 'concentrated',
            state: concentrated.state, action: concentrated.action,
            labels: { sloViolationWithinKTransitions: concentrated.unsafe },
            truth: { unsafe: concentrated.unsafe, violationClass: concentrated.violationClass },
        },
    ];
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const rows = [];
    for (let index = 0; index < options.pairs; index += 1) {
        rows.push(...await buildPair(index, options.seed + index));
    }
    const output = path.resolve(options.out);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    const result = { output, pairs: options.pairs, records: rows.length };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
}

if (require.main === module) void main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});

module.exports = { buildPair, main, parseArgs, topology };
