'use strict';

// Fault model for the Operations Console: named families that expand, for a
// given world, into concrete fault variants. A variant is a short timeline of
// CloudProof Mesh actions relative to its injection time (a zone that degrades
// and later recovers, a spike that later subsides). `readiness-delay` is the
// one family that edits the world instead: pods take longer to become ready.

const { MESH_ACTION, MESH_FAULT, SERVICE_KIND, TIMING } = require('../cloudproof-mesh/constants');

const ZONE_OUTAGE_MS = 5000;
const SPIKE_MS = 6000;
const SPIKE_FACTORS = Object.freeze([1.3, 1.6]);
const STALL_MS = Object.freeze([2000, 5000]);
const READINESS_FACTOR = 3;

const FAULT_FAMILIES = Object.freeze({
    'node-crash': { title: 'Node crash', modeled: true, detail: 'a node fails; its pods are rescheduled after the eviction delay' },
    'zone-degraded': { title: 'Zone degradation', modeled: true, detail: `every node and volume in one zone stops serving for ${ZONE_OUTAGE_MS / 1000} s` },
    'readiness-delay': { title: 'Readiness delay', modeled: true, detail: `new pods take ${READINESS_FACTOR}× longer to become ready` },
    'dependency-latency': { title: 'Dependency latency', modeled: false, detail: 'not modeled: the Phase III mesh has no latency dimension' },
    'cache-loss': { title: 'Cache loss', modeled: true, detail: `a cache is flushed and misses everything for ${TIMING.cacheWarmupMs / 1000} s` },
    'consumer-stall': { title: 'Queue consumer stall', modeled: true, detail: 'a worker service stops consuming for a while' },
    'db-failover': { title: 'Database failover', modeled: true, detail: 'a primary database crashes; the replica is promoted after 1.5 s' },
    'traffic-spike': { title: 'Traffic spike', modeled: true, detail: `traffic rises ×${SPIKE_FACTORS.join(' or ×')} for ${SPIKE_MS / 1000} s` },
});

function validateFamilies(families) {
    if (!Array.isArray(families)) throw new TypeError('faults must be a list of fault families');
    for (const family of families) {
        if (!FAULT_FAMILIES[family]) throw new TypeError(`unknown fault family: ${family}`);
        if (!FAULT_FAMILIES[family].modeled) throw new TypeError(`${FAULT_FAMILIES[family].title} is not modeled by the simulator`);
    }
    return true;
}

/** Slot-placed fault variants the families expand to in this world. */
function faultVariants(world, families) {
    validateFamilies(families);
    const enabled = new Set(families);
    const variants = [];
    const add = (id, family, label, timeline) => variants.push({ id, family, label, timeline });
    if (enabled.has('node-crash')) {
        for (const node of world.nodes) {
            add(`node-crash:${node.id}`, 'node-crash', `${node.id} crashes`,
                [{ dt: 0, action: { type: MESH_FAULT.NODE_CRASH, nodeId: node.id } }]);
        }
    }
    if (enabled.has('zone-degraded')) {
        for (const zone of world.zones) {
            add(`zone-degraded:${zone.id}`, 'zone-degraded', `${zone.id} degraded (${ZONE_OUTAGE_MS / 1000} s)`, [
                { dt: 0, action: { type: MESH_FAULT.ZONE_DEGRADED, zoneId: zone.id } },
                { dt: ZONE_OUTAGE_MS, action: { type: MESH_ACTION.RECOVER_ZONE, zoneId: zone.id } },
            ]);
        }
    }
    if (enabled.has('traffic-spike')) {
        for (const factor of SPIKE_FACTORS) {
            add(`traffic-spike:${factor}`, 'traffic-spike', `traffic ×${factor} (${SPIKE_MS / 1000} s)`, [
                { dt: 0, action: { type: MESH_FAULT.TRAFFIC_SPIKE, factor } },
                { dt: SPIKE_MS, action: { type: MESH_ACTION.TRAFFIC_SHIFT, rps: world.traffic.rps } },
            ]);
        }
    }
    if (enabled.has('cache-loss')) {
        for (const item of world.services.filter((candidate) => candidate.kind === SERVICE_KIND.CACHE)) {
            add(`cache-loss:${item.id}`, 'cache-loss', `${item.id} flushed`,
                [{ dt: 0, action: { type: MESH_FAULT.CACHE_FLUSH, serviceId: item.id } }]);
        }
    }
    if (enabled.has('consumer-stall')) {
        for (const item of world.services.filter((candidate) => candidate.kind === SERVICE_KIND.WORKER)) {
            for (const durationMs of STALL_MS) {
                add(`consumer-stall:${item.id}:${durationMs}`, 'consumer-stall', `${item.id} stalls ${durationMs / 1000} s`,
                    [{ dt: 0, action: { type: MESH_FAULT.CONSUMER_STALL, serviceId: item.id, durationMs } }]);
            }
        }
    }
    if (enabled.has('db-failover')) {
        const primaries = world.services.filter((item) => item.role === 'primary'
            && world.dependencies.some((edge) => edge.type === 'REPLICATES' && edge.from === item.id));
        for (const item of primaries) {
            add(`db-failover:${item.id}`, 'db-failover', `${item.id} primary crashes`,
                world.placement[item.id].map((_, index) => ({ dt: 0, action: { type: MESH_FAULT.POD_CRASH, podId: `pod/${item.id}-${index + 1}` } })));
        }
    }
    return variants;
}

/** World edit for the readiness-delay family: every pod starts slower. */
function applyReadinessDelay(world) {
    const next = JSON.parse(JSON.stringify(world));
    for (const item of next.services) item.startupMs = Math.min(60_000, item.startupMs * READINESS_FACTOR);
    return next;
}

/** Expand placed variants into absolute-time fault actions, stable by time. */
function expandPlacements(placements, variantsById) {
    const actions = [];
    placements.forEach((placement, order) => {
        const variant = variantsById.get(placement.variant);
        variant.timeline.forEach((entry, index) => actions.push({
            atMs: placement.atMs + entry.dt,
            action: entry.action,
            variant: variant.id,
            label: index === 0 ? variant.label : `${variant.label}: ends`,
            order,
            index,
        }));
    });
    return actions.sort((left, right) => left.atMs - right.atMs || left.order - right.order || left.index - right.index)
        .map(({ atMs, action, variant, label }) => ({ atMs, action, variant, label }));
}

function placementLabel(placements, readiness, variantsById) {
    const parts = placements.map((placement) => `${variantsById.get(placement.variant).label} @${(placement.atMs / 1000).toFixed(1)}s`);
    if (readiness) parts.push('slow readiness');
    return parts.join(' + ') || 'no faults';
}

module.exports = {
    FAULT_FAMILIES,
    READINESS_FACTOR,
    SPIKE_FACTORS,
    SPIKE_MS,
    STALL_MS,
    ZONE_OUTAGE_MS,
    applyReadinessDelay,
    expandPlacements,
    faultVariants,
    placementLabel,
    validateFamilies,
};
