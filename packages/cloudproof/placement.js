'use strict';

// Initial placement is the one topology variable Phase II-A could not vary:
// createCloudResources always dealt pods round-robin over nodes, so pod-to-zone
// wiring was a deterministic function of replica count. Counterfactual pairs
// need two worlds that differ only in that wiring, and they must stay ordinary
// replayable schedules rather than post-construction state edits.

function slotsPerNode(topology) {
    return Math.max(1, Math.min(
        Math.floor(topology.nodeCpuMillicores / topology.podCpuMillicores),
        Math.floor(topology.nodeMemoryMb / topology.podMemoryMb),
    ));
}

function defaultNodesPerZone(topology) {
    const perZone = Math.max(1, Math.ceil(topology.initialReplicas
        / (slotsPerNode(topology) * Math.max(1, topology.zones - 1))));
    return Array.from({ length: topology.zones }, () => perZone);
}

// Reproduces the historical round-robin deal so a null placement is
// byte-identical to every Phase I and Phase II-A state.
function roundRobinPodsPerZone(topology, nodesPerZone) {
    const zoneOfNode = [];
    nodesPerZone.forEach((count, zoneIndex) => {
        for (let ordinal = 0; ordinal < count; ordinal += 1) zoneOfNode.push(zoneIndex);
    });
    const counts = Array.from({ length: topology.zones }, () => 0);
    for (let index = 0; index < topology.initialReplicas; index += 1) {
        counts[zoneOfNode[index % zoneOfNode.length]] += 1;
    }
    return counts;
}

function integerVector(value, name, length, minimum) {
    if (!Array.isArray(value) || value.length !== length) {
        throw new TypeError(`${name} must be an array of length ${length}`);
    }
    value.forEach((item) => {
        if (!Number.isInteger(item) || item < minimum) {
            throw new TypeError(`${name} entries must be integers >= ${minimum}`);
        }
    });
    return value.slice();
}

function normalizePlacement(topology, placement = null) {
    if (placement === null || placement === undefined) return null;
    if (typeof placement !== 'object') throw new TypeError('placement must be an object');
    const nodesPerZone = placement.nodesPerZone === undefined || placement.nodesPerZone === null
        ? defaultNodesPerZone(topology)
        : integerVector(placement.nodesPerZone, 'placement.nodesPerZone', topology.zones, 1);
    const podsPerZone = placement.podsPerZone === undefined || placement.podsPerZone === null
        ? roundRobinPodsPerZone(topology, nodesPerZone)
        : integerVector(placement.podsPerZone, 'placement.podsPerZone', topology.zones, 0);
    const total = podsPerZone.reduce((sum, value) => sum + value, 0);
    if (total !== topology.initialReplicas) {
        throw new TypeError(`placement.podsPerZone must sum to ${topology.initialReplicas}, got ${total}`);
    }
    const slots = slotsPerNode(topology);
    podsPerZone.forEach((count, zoneIndex) => {
        if (count > nodesPerZone[zoneIndex] * slots) {
            throw new TypeError(`placement puts ${count} pods in zone ${zoneIndex} with capacity `
                + `${nodesPerZone[zoneIndex] * slots}`);
        }
    });
    return { nodesPerZone, podsPerZone };
}

function balancedPodsPerZone(replicas, zones) {
    const base = Math.floor(replicas / zones);
    const remainder = replicas - base * zones;
    return Array.from({ length: zones }, (_, index) => base + (index < remainder ? 1 : 0));
}

// Concentrates as many pods as the target zone can hold, then deals the rest
// over the other zones one at a time, so both worlds keep identical pod and
// node multisets and differ only in RUNS_ON / LOCATED_IN wiring.
function concentratedPodsPerZone(topology, nodesPerZone, targetZoneIndex) {
    const slots = slotsPerNode(topology);
    const counts = Array.from({ length: topology.zones }, () => 0);
    let remaining = topology.initialReplicas;
    const target = Math.min(remaining, nodesPerZone[targetZoneIndex] * slots);
    counts[targetZoneIndex] = target;
    remaining -= target;
    let cursor = 0;
    while (remaining > 0) {
        const zoneIndex = cursor % topology.zones;
        cursor += 1;
        if (zoneIndex === targetZoneIndex) continue;
        if (counts[zoneIndex] >= nodesPerZone[zoneIndex] * slots) {
            if (cursor > topology.zones * (slots + 1)) throw new Error('placement does not fit the cluster');
            continue;
        }
        counts[zoneIndex] += 1;
        remaining -= 1;
    }
    return counts;
}

function zoneName(index) {
    return `zone-${String.fromCharCode(97 + index)}`;
}

// Node naming is shared with resources.js so the outcome-blind generator can
// target nodes by name before any state exists.
function nodeNameList(topology, nodesPerZone = null) {
    const perZone = nodesPerZone || defaultNodesPerZone(topology);
    const names = [];
    for (let zoneIndex = 0; zoneIndex < topology.zones; zoneIndex += 1) {
        const base = `node-${String.fromCharCode(97 + zoneIndex)}`;
        for (let ordinal = 1; ordinal <= perZone[zoneIndex]; ordinal += 1) {
            names.push({ name: ordinal === 1 ? base : `${base}-${ordinal}`, zone: zoneName(zoneIndex) });
        }
    }
    return names;
}

function placementConcentration(podsPerZone) {
    const total = podsPerZone.reduce((sum, value) => sum + value, 0);
    return total === 0 ? 0 : Math.max(...podsPerZone) / total;
}

module.exports = {
    balancedPodsPerZone,
    concentratedPodsPerZone,
    defaultNodesPerZone,
    nodeNameList,
    normalizePlacement,
    placementConcentration,
    roundRobinPodsPerZone,
    slotsPerNode,
    zoneName,
};
