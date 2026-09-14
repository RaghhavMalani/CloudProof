'use strict';

const { digest } = require('../agent-runtime');

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

const TOPOLOGY_SCHEMA_VERSION = 1;
const DATASET_SCHEMA_VERSION = 2;
const SPLIT_POLICY = 'topology-holdout-v1';

const DEFAULT_TOPOLOGY = Object.freeze({
    zones: 3,
    initialReplicas: 6,
    maxUnavailable: 1,
    maxSurge: 1,
    pdbMinAvailable: 4,
    hpaMinReplicas: 4,
    hpaMaxReplicas: 12,
    hpaTarget: 70,
    serviceMinimumReady: 4,
    nodeCpuMillicores: 4000,
    nodeMemoryMb: 8192,
    podCpuMillicores: 500,
    podMemoryMb: 512,
});

function integer(value, name, minimum, maximum = Infinity) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(`${name} must be an integer in [${minimum}, ${maximum}]`);
    }
    return value;
}

function normalizeTopology(input = {}) {
    const topology = { ...DEFAULT_TOPOLOGY, ...input };
    if (input.maxUnavailable === undefined) {
        topology.maxUnavailable = Math.min(DEFAULT_TOPOLOGY.maxUnavailable, topology.initialReplicas);
    }
    if (input.maxSurge === undefined) {
        topology.maxSurge = Math.min(DEFAULT_TOPOLOGY.maxSurge, topology.initialReplicas);
    }
    if (input.pdbMinAvailable === undefined) {
        topology.pdbMinAvailable = Math.min(DEFAULT_TOPOLOGY.pdbMinAvailable, topology.initialReplicas);
    }
    if (input.hpaMinReplicas === undefined) {
        topology.hpaMinReplicas = Math.min(DEFAULT_TOPOLOGY.hpaMinReplicas, topology.initialReplicas);
    }
    if (input.hpaMaxReplicas === undefined) {
        topology.hpaMaxReplicas = Math.max(DEFAULT_TOPOLOGY.hpaMaxReplicas, topology.initialReplicas);
    }
    if (input.serviceMinimumReady === undefined) {
        topology.serviceMinimumReady = Math.min(DEFAULT_TOPOLOGY.serviceMinimumReady,
            topology.initialReplicas);
    }
    integer(topology.zones, 'zones', 2, 26);
    integer(topology.initialReplicas, 'initialReplicas', 1, 1000);
    integer(topology.maxUnavailable, 'maxUnavailable', 0, topology.initialReplicas);
    integer(topology.maxSurge, 'maxSurge', 0, topology.initialReplicas);
    integer(topology.pdbMinAvailable, 'pdbMinAvailable', 0, topology.initialReplicas);
    integer(topology.hpaMinReplicas, 'hpaMinReplicas', 1, topology.initialReplicas);
    integer(topology.hpaMaxReplicas, 'hpaMaxReplicas', topology.initialReplicas, 1000);
    integer(topology.hpaTarget, 'hpaTarget', 1, 100);
    integer(topology.serviceMinimumReady, 'serviceMinimumReady', 1, topology.initialReplicas);
    integer(topology.nodeCpuMillicores, 'nodeCpuMillicores', 1);
    integer(topology.nodeMemoryMb, 'nodeMemoryMb', 1);
    integer(topology.podCpuMillicores, 'podCpuMillicores', 1);
    integer(topology.podMemoryMb, 'podMemoryMb', 1);
    return stable(Object.fromEntries(Object.keys(DEFAULT_TOPOLOGY).map((key) => [key, topology[key]])));
}

function topologyFingerprint(input) {
    return digest({ schemaVersion: TOPOLOGY_SCHEMA_VERSION, topology: normalizeTopology(input) });
}

function topologyId(input) {
    return `topology-${topologyFingerprint(input).slice(0, 16)}`;
}

function catalogEntry(label, split, values) {
    const topology = normalizeTopology(values);
    return Object.freeze(stable({
        label,
        split,
        topology,
        topologyId: topologyId(topology),
    }));
}

// A-M are intentionally fixed research holdouts. No transition-row shuffling is
// permitted: every row from a topology inherits its topology's split.
const TOPOLOGY_CATALOG = Object.freeze([
    catalogEntry('A', 'train', { initialReplicas: 3, zones: 2, maxUnavailable: 0, maxSurge: 1,
        pdbMinAvailable: 2, hpaMinReplicas: 2, hpaMaxReplicas: 6, hpaTarget: 60,
        serviceMinimumReady: 2 }),
    catalogEntry('B', 'train', { initialReplicas: 3, zones: 3, maxUnavailable: 1, maxSurge: 0,
        pdbMinAvailable: 2, hpaMinReplicas: 2, hpaMaxReplicas: 6, hpaTarget: 75,
        serviceMinimumReady: 2 }),
    catalogEntry('C', 'train', { initialReplicas: 4, zones: 2, maxUnavailable: 1, maxSurge: 1,
        pdbMinAvailable: 3, hpaMinReplicas: 2, hpaMaxReplicas: 8, hpaTarget: 65,
        serviceMinimumReady: 3 }),
    catalogEntry('D', 'train', { initialReplicas: 4, zones: 3, maxUnavailable: 0, maxSurge: 2,
        pdbMinAvailable: 4, hpaMinReplicas: 3, hpaMaxReplicas: 8, hpaTarget: 80,
        serviceMinimumReady: 3 }),
    catalogEntry('E', 'train', { initialReplicas: 6, zones: 2, maxUnavailable: 1, maxSurge: 2,
        pdbMinAvailable: 4, hpaMinReplicas: 3, hpaMaxReplicas: 12, hpaTarget: 50,
        serviceMinimumReady: 4 }),
    catalogEntry('F', 'train', { initialReplicas: 6, zones: 3, maxUnavailable: 2, maxSurge: 1,
        pdbMinAvailable: 4, hpaMinReplicas: 4, hpaMaxReplicas: 12, hpaTarget: 85,
        serviceMinimumReady: 4 }),
    catalogEntry('G', 'train', { initialReplicas: 3, zones: 2, maxUnavailable: 2, maxSurge: 0,
        pdbMinAvailable: 2, hpaMinReplicas: 2, hpaMaxReplicas: 8, hpaTarget: 55,
        serviceMinimumReady: 2 }),
    catalogEntry('H', 'train', { initialReplicas: 4, zones: 3, maxUnavailable: 2, maxSurge: 2,
        pdbMinAvailable: 2, hpaMinReplicas: 2, hpaMaxReplicas: 10, hpaTarget: 80,
        serviceMinimumReady: 2 }),
    catalogEntry('I', 'validation', { initialReplicas: 6, zones: 2, maxUnavailable: 0, maxSurge: 0,
        pdbMinAvailable: 5, hpaMinReplicas: 4, hpaMaxReplicas: 10, hpaTarget: 70,
        serviceMinimumReady: 5 }),
    catalogEntry('J', 'validation', { initialReplicas: 3, zones: 3, maxUnavailable: 1, maxSurge: 2,
        pdbMinAvailable: 3, hpaMinReplicas: 1, hpaMaxReplicas: 7, hpaTarget: 50,
        serviceMinimumReady: 2 }),
    catalogEntry('K', 'test', { initialReplicas: 4, zones: 2, maxUnavailable: 0, maxSurge: 1,
        pdbMinAvailable: 2, hpaMinReplicas: 3, hpaMaxReplicas: 9, hpaTarget: 85,
        serviceMinimumReady: 3 }),
    catalogEntry('L', 'test', { initialReplicas: 6, zones: 3, maxUnavailable: 1, maxSurge: 0,
        pdbMinAvailable: 6, hpaMinReplicas: 3, hpaMaxReplicas: 11, hpaTarget: 60,
        serviceMinimumReady: 4 }),
    catalogEntry('M', 'test', { initialReplicas: 3, zones: 2, maxUnavailable: 1, maxSurge: 2,
        pdbMinAvailable: 2, hpaMinReplicas: 1, hpaMaxReplicas: 9, hpaTarget: 70,
        serviceMinimumReady: 2 }),
    catalogEntry('OOD-A', 'ood', { initialReplicas: 8, zones: 2, maxUnavailable: 1, maxSurge: 1,
        pdbMinAvailable: 6, hpaMinReplicas: 4, hpaMaxReplicas: 16, hpaTarget: 55,
        serviceMinimumReady: 6 }),
    catalogEntry('OOD-B', 'ood', { initialReplicas: 8, zones: 3, maxUnavailable: 2, maxSurge: 0,
        pdbMinAvailable: 5, hpaMinReplicas: 5, hpaMaxReplicas: 16, hpaTarget: 75,
        serviceMinimumReady: 6 }),
    catalogEntry('OOD-C', 'ood', { initialReplicas: 12, zones: 2, maxUnavailable: 0, maxSurge: 2,
        pdbMinAvailable: 10, hpaMinReplicas: 6, hpaMaxReplicas: 24, hpaTarget: 65,
        serviceMinimumReady: 9 }),
    catalogEntry('OOD-D', 'ood', { initialReplicas: 12, zones: 3, maxUnavailable: 2, maxSurge: 1,
        pdbMinAvailable: 8, hpaMinReplicas: 6, hpaMaxReplicas: 24, hpaTarget: 85,
        serviceMinimumReady: 8 }),
]);

function assertDisjointTopologySplits(entries = TOPOLOGY_CATALOG) {
    const owners = new Map();
    for (const entry of entries) {
        const existing = owners.get(entry.topologyId);
        if (existing && existing !== entry.split) {
            throw new Error(`topology ${entry.topologyId} appears in both ${existing} and ${entry.split}`);
        }
        owners.set(entry.topologyId, entry.split);
    }
    return true;
}

assertDisjointTopologySplits();

module.exports = {
    DATASET_SCHEMA_VERSION,
    DEFAULT_TOPOLOGY,
    SPLIT_POLICY,
    TOPOLOGY_CATALOG,
    TOPOLOGY_SCHEMA_VERSION,
    assertDisjointTopologySplits,
    normalizeTopology,
    topologyFingerprint,
    topologyId,
};
