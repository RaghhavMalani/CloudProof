'use strict';

// Rule-based remediation candidates.
//
// A candidate is data: a partial edit to the change and/or a list of world
// edits. Rules read only the counterexample's root cause and the change; no
// model ranks them and nothing claims a candidate works until the verifier
// has run it.

const { SERVICE_KIND } = require('../cloudproof-mesh/constants');
const { validateWorld } = require('../cloudproof-mesh/world');
const { validateChange } = require('./changes');

const clone = (value) => JSON.parse(JSON.stringify(value));

function serviceOf(world, id) {
    return world.services.find((item) => item.id === id) || null;
}

function usageByNode(world, excluding = null) {
    const used = new Map(world.nodes.map((node) => [node.id, 0]));
    for (const [serviceId, nodes] of Object.entries(world.placement)) {
        if (serviceId === excluding) continue;
        for (const node of nodes) used.set(node, used.get(node) + 1);
    }
    return used;
}

function volumeZone(world, service) {
    return service.volume ? world.volumes.find((item) => item.id === service.volume).zone : null;
}

// Place one more pod: the zone with the fewest pods of this service, then the
// least-used node there with a free slot. Ties break by id.
function placeOne(world, service, current, used) {
    const zoneCount = new Map(world.zones.map((zone) => [zone.id, 0]));
    const zoneOfNode = new Map(world.nodes.map((node) => [node.id, node.zone]));
    for (const node of current) zoneCount.set(zoneOfNode.get(node), zoneCount.get(zoneOfNode.get(node)) + 1);
    const fixedZone = volumeZone(world, service);
    const candidates = world.nodes.filter((node) => used.get(node.id) < node.slots && (!fixedZone || node.zone === fixedZone));
    if (!candidates.length) throw new TypeError(`no free slot for another ${service.id} pod`);
    candidates.sort((left, right) => zoneCount.get(left.zone) - zoneCount.get(right.zone)
        || used.get(left.id) - used.get(right.id) || left.id.localeCompare(right.id));
    const chosen = candidates[0];
    used.set(chosen.id, used.get(chosen.id) + 1);
    return chosen.id;
}

const WORLD_EDITS = {
    replicas(world, edit) {
        const service = serviceOf(world, edit.service);
        const used = usageByNode(world);
        const placement = world.placement[edit.service].slice(0, edit.replicas);
        for (const node of world.placement[edit.service].slice(edit.replicas)) used.set(node, used.get(node) - 1);
        while (placement.length < edit.replicas) placement.push(placeOne(world, service, placement, used));
        service.replicas = edit.replicas;
        service.minHealthy = Math.min(service.minHealthy, edit.replicas);
        world.placement[edit.service] = placement;
    },
    spread(world, edit) {
        const service = serviceOf(world, edit.service);
        const used = usageByNode(world, edit.service);
        const placement = [];
        for (let index = 0; index < service.replicas; index += 1) placement.push(placeOne(world, service, placement, used));
        world.placement[edit.service] = placement;
    },
    capacity(world, edit) {
        serviceOf(world, edit.service).podCapacityRps = edit.podCapacityRps;
    },
    'queue-capacity': function queueCapacity(world, edit) {
        serviceOf(world, edit.service).queueCapacity = edit.queueCapacity;
    },
};

/** Apply a candidate to a configuration; returns a new, validated one. */
function applyRemediation({ world, change }, remediation) {
    const nextWorld = clone(world);
    for (const edit of remediation.worldEdits || []) {
        if (!WORLD_EDITS[edit.op]) throw new TypeError(`unknown world edit: ${edit.op}`);
        WORLD_EDITS[edit.op](nextWorld, edit);
    }
    validateWorld(nextWorld);
    // A recorded incident has no change: only world edits apply to it.
    if (!change) {
        if (remediation.changeEdit) throw new TypeError('this candidate edits a change, and there is none');
        return { world: nextWorld, change: null };
    }
    const nextChange = { ...clone(change), ...(remediation.changeEdit || {}) };
    validateChange(nextWorld, nextChange);
    return { world: nextWorld, change: nextChange };
}

function zoneSpread(world, serviceId) {
    const zoneOfNode = new Map(world.nodes.map((node) => [node.id, node.zone]));
    const counts = new Map(world.zones.map((zone) => [zone.id, 0]));
    for (const node of world.placement[serviceId]) counts.set(zoneOfNode.get(node), counts.get(zoneOfNode.get(node)) + 1);
    return counts;
}

/**
 * Candidate fixes for a counterexample. `cause` is the root cause the
 * explanation computed ({ root, incidentClass, chain }).
 */
function remediationsFor({ world, change: proposed = null, labels = {} }, cause) {
    const change = proposed || { type: null };
    const name = (id) => labels[id] || id;
    const out = [];
    const add = (candidate) => {
        if (out.some((item) => item.id === candidate.id)) return;
        try {
            applyRemediation({ world, change: proposed }, candidate);
            out.push(candidate);
        } catch (_) {
            // A rule whose edit is not valid for this world is skipped, not shown.
        }
    };
    const root = cause?.root ? serviceOf(world, cause.root) : null;
    const target = change.service ? serviceOf(world, change.service) : null;

    if (change.type === 'rollout' && change.maxUnavailable > 0) {
        add({
            id: 'rollout-max-unavailable-0',
            title: `Reduce maxUnavailable ${change.maxUnavailable} → 0`,
            rationale: 'Replace pods only after a surge pod is ready, so serving capacity never drops below the replica count.',
            changeEdit: { maxUnavailable: 0, maxSurge: Math.max(1, change.maxSurge) },
            diff: [
                { field: `${change.service}.maxUnavailable`, before: change.maxUnavailable, after: 0 },
                ...(change.maxSurge < 1 ? [{ field: `${change.service}.maxSurge`, before: change.maxSurge, after: 1 }] : []),
            ],
        });
    }
    if (change.type === 'rollout') {
        add({
            id: `replicas-${change.service}`,
            title: `Increase ${name(change.service)} replicas ${target.replicas} → ${target.replicas + 1}`,
            rationale: 'One more replica absorbs the pod that is out of service while it is being replaced.',
            worldEdits: [{ op: 'replicas', service: change.service, replicas: target.replicas + 1 }],
            diff: [{ field: `${change.service}.replicas`, before: target.replicas, after: target.replicas + 1 }],
        });
    }
    if (change.type === 'scale' && target && change.replicas < target.replicas && change.replicas + 1 < target.replicas) {
        add({
            id: `scale-less-${change.service}`,
            title: `Scale ${name(change.service)} to ${change.replicas + 1} instead of ${change.replicas}`,
            rationale: 'A smaller cut keeps more headroom for the faults in the model.',
            changeEdit: { replicas: change.replicas + 1 },
            diff: [{ field: `${change.service}.replicas (target)`, before: change.replicas, after: change.replicas + 1 }],
        });
    }
    if (change.type === 'drain-zone' && change.intervalMs < 30_000) {
        const slower = Math.min(30_000, Math.max(2000, change.intervalMs * 3));
        add({
            id: 'drain-slower',
            title: `Drain one node every ${(slower / 1000).toFixed(1)} s`,
            rationale: 'Give evicted pods time to become ready elsewhere before the next node goes.',
            changeEdit: { intervalMs: slower },
            diff: [{ field: 'drain interval', before: `${(change.intervalMs / 1000).toFixed(1)} s`, after: `${(slower / 1000).toFixed(1)} s` }],
        });
    }
    if (root && root.kind !== SERVICE_KIND.DATABASE && root.kind !== SERVICE_KIND.QUEUE
        && ['INSTANCE_LOSS', 'OVERLOAD'].includes(cause.incidentClass) && root.id !== change.service) {
        add({
            id: `replicas-${root.id}`,
            title: `Increase ${name(root.id)} replicas ${root.replicas} → ${root.replicas + 1}`,
            rationale: `${name(root.id)} is where the failure starts; one more replica raises both its healthy count and its capacity.`,
            worldEdits: [{ op: 'replicas', service: root.id, replicas: root.replicas + 1 }],
            diff: [{ field: `${root.id}.replicas`, before: root.replicas, after: root.replicas + 1 }],
        });
    }
    if (root && cause.incidentClass === 'INSTANCE_LOSS' && root.kind !== SERVICE_KIND.DATABASE) {
        const counts = zoneSpread(world, root.id);
        const fair = Math.ceil(root.replicas / world.zones.length);
        if (Math.max(...counts.values()) > fair) {
            add({
                id: `spread-${root.id}`,
                title: `Spread ${name(root.id)} evenly across zones`,
                rationale: `${[...counts].map(([zone, count]) => `${count} in ${zone}`).join(', ')}: one zone holds more than its share.`,
                worldEdits: [{ op: 'spread', service: root.id }],
                diff: [{ field: `${root.id}.placement`, before: [...counts].map(([, count]) => count).join('/'), after: 'even' }],
            });
        }
    }
    if (root && ['OVERLOAD', 'CACHE_STAMPEDE'].includes(cause.incidentClass) && root.kind !== SERVICE_KIND.QUEUE) {
        const raised = Math.ceil(root.podCapacityRps * 1.25);
        add({
            id: `capacity-${root.id}`,
            title: `Raise ${name(root.id)} per-pod capacity ${root.podCapacityRps} → ${raised} rps`,
            rationale: 'Vertical headroom for the load the failure put on it.',
            worldEdits: [{ op: 'capacity', service: root.id, podCapacityRps: raised }],
            diff: [{ field: `${root.id}.podCapacityRps`, before: root.podCapacityRps, after: raised }],
        });
    }
    if (root && cause.incidentClass === 'CACHE_STAMPEDE') {
        for (const cache of world.services.filter((item) => item.kind === SERVICE_KIND.CACHE
            && world.dependencies.some((edge) => edge.type === 'BACKED_BY' && edge.from === item.id && edge.to === root.id))) {
            add({
                id: `replicas-${cache.id}`,
                title: `Increase ${name(cache.id)} replicas ${cache.replicas} → ${cache.replicas + 1}`,
                rationale: 'Keep the cache above its minimum when one of its pods is lost, so reads do not fall through.',
                worldEdits: [{ op: 'replicas', service: cache.id, replicas: cache.replicas + 1 }],
                diff: [{ field: `${cache.id}.replicas`, before: cache.replicas, after: cache.replicas + 1 }],
            });
        }
    }
    if (root && ['QUEUE_BACKLOG', 'QUEUE_BACKPRESSURE'].includes(cause.incidentClass)) {
        for (const edge of world.dependencies.filter((item) => item.type === 'CONSUMES' && item.to === root.id)) {
            const worker = serviceOf(world, edge.from);
            const raised = Math.ceil(worker.podCapacityRps * 1.5);
            add({
                id: `capacity-${worker.id}`,
                title: `Raise ${name(worker.id)} per-pod throughput ${worker.podCapacityRps} → ${raised} msg/s`,
                rationale: 'Faster consumers drain the backlog after a surge or a stall.',
                worldEdits: [{ op: 'capacity', service: worker.id, podCapacityRps: raised }],
                diff: [{ field: `${worker.id}.podCapacityRps`, before: worker.podCapacityRps, after: raised }],
            });
            if (!(change.type === 'scale' && change.service === worker.id)) {
                add({
                    id: `replicas-${worker.id}`,
                    title: `Add a ${name(worker.id)} consumer (${worker.replicas} → ${worker.replicas + 1})`,
                    rationale: 'More consumers drain the queue faster.',
                    worldEdits: [{ op: 'replicas', service: worker.id, replicas: worker.replicas + 1 }],
                    diff: [{ field: `${worker.id}.replicas`, before: worker.replicas, after: worker.replicas + 1 }],
                });
            }
        }
        if (cause.incidentClass === 'QUEUE_BACKPRESSURE') {
            add({
                id: `queue-capacity-${root.id}`,
                title: `Double ${name(root.id)} capacity ${root.queueCapacity} → ${root.queueCapacity * 2} messages`,
                rationale: 'A deeper queue absorbs a longer stall before publishers are pushed back.',
                worldEdits: [{ op: 'queue-capacity', service: root.id, queueCapacity: root.queueCapacity * 2 }],
                diff: [{ field: `${root.id}.queueCapacity`, before: root.queueCapacity, after: root.queueCapacity * 2 }],
            });
        }
    }
    return out.slice(0, 5);
}

module.exports = { applyRemediation, remediationsFor };
