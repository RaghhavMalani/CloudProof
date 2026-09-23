'use strict';

// Outcome-blind world and schedule generation for CloudProof Mesh
// (CLOUDPROOF-PHASE-III-MULTISERVICE.md, sections 5 and 6). Nothing here reads
// an outcome: worlds are sampled from structural templates, capacities are
// sized from the healthy steady-state load, and schedules are sampled from one
// hazard process whatever they execute to.

const { Rng } = require('../../sim/simulator');
const { ERROR_BUDGET_PCT, MESH_ACTION, MESH_FAULT, RELATION, SERVICE_KIND } = require('./constants');
const { WORLD_KIND, WORLD_SCHEMA_VERSION, computeLoads, stable, validateWorld } = require('./world');

// Template ranges and the natural schedule process were frozen after the
// III-A.2 simulator-only pilot (section 12); the split of templates was fixed
// before any code existed.
const COMMON = Object.freeze({
    routes: [2, 3],
    replicas: [2, 4],
    slots: 8,
    optionalProbability: 0.25,
    utilization: [0.25, 0.55],
    databaseUtilization: [0.40, 0.85],
    queueSeconds: [1, 5],
    startupMs: [600, 2000],
    replicaDatabaseProbability: 0.5,
});

const TEMPLATES = Object.freeze([
    { id: 'T1', split: 'train', zones: [2, 2], nodesPerZone: [2, 3], depth: [1, 1], mids: [2, 3], databases: [1, 1], caches: [0, 0], queues: [0, 0] },
    { id: 'T2', split: 'train', zones: [3, 3], nodesPerZone: [2, 2], depth: [1, 2], mids: [2, 3], databases: [1, 2], caches: [1, 1], queues: [0, 0] },
    { id: 'T3', split: 'train', zones: [2, 3], nodesPerZone: [2, 3], depth: [2, 2], mids: [2, 3], databases: [1, 1], caches: [0, 0], queues: [1, 1] },
    { id: 'T4', split: 'train', zones: [3, 3], nodesPerZone: [2, 3], depth: [1, 1], mids: [3, 4], databases: [2, 2], caches: [2, 2], queues: [0, 0] },
    { id: 'T5', split: 'train', zones: [2, 2], nodesPerZone: [3, 3], depth: [2, 2], mids: [2, 2], databases: [1, 2], caches: [1, 1], queues: [1, 1] },
    { id: 'T6', split: 'train', zones: [3, 3], nodesPerZone: [2, 2], depth: [1, 2], mids: [2, 4], databases: [2, 2], caches: [0, 1], queues: [0, 1] },
    { id: 'T7', split: 'train', zones: [2, 3], nodesPerZone: [2, 2], depth: [1, 1], mids: [2, 3], databases: [1, 1], caches: [2, 2], queues: [1, 1] },
    { id: 'T8', split: 'train', zones: [3, 3], nodesPerZone: [3, 3], depth: [2, 2], mids: [3, 3], databases: [2, 2], caches: [1, 2], queues: [0, 0] },
    { id: 'V1', split: 'validation', zones: [2, 2], nodesPerZone: [2, 2], depth: [2, 2], mids: [3, 4], databases: [2, 2], caches: [2, 2], queues: [0, 0] },
    { id: 'V2', split: 'validation', zones: [3, 3], nodesPerZone: [3, 3], depth: [1, 1], mids: [2, 2], databases: [1, 1], caches: [0, 0], queues: [1, 1] },
    { id: 'X1', split: 'test', zones: [3, 3], nodesPerZone: [2, 3], depth: [3, 3], mids: [2, 3], databases: [1, 2], caches: [1, 1], queues: [1, 1] },
    { id: 'X2', split: 'test', zones: [3, 3], nodesPerZone: [2, 2], depth: [3, 3], mids: [3, 3], databases: [2, 2], caches: [2, 2], queues: [1, 1] },
    { id: 'O1', split: 'ood', zones: [4, 4], nodesPerZone: [3, 4], depth: [3, 3], mids: [4, 5], databases: [2, 3], caches: [2, 2], queues: [1, 2] },
    { id: 'O2', split: 'ood', zones: [4, 4], nodesPerZone: [4, 4], depth: [3, 3], mids: [5, 6], databases: [3, 3], caches: [2, 3], queues: [2, 2] },
].map((template) => Object.freeze({ ...COMMON, ...template })));

function template(id) {
    const found = TEMPLATES.find((candidate) => candidate.id === id);
    if (!found) throw new TypeError(`unknown mesh template: ${id}`);
    return found;
}

const range = (rng, [low, high]) => rng.range(low, high);
const zoneId = (index) => `zone-${String.fromCharCode(97 + index)}`;
const pad = (value) => String(value).padStart(2, '0');

// Integer shares summing to `total`, each at least 1 (largest remainder).
function composeShares(rng, count, total) {
    const weights = Array.from({ length: count }, () => rng.range(1, 6));
    const sum = weights.reduce((left, right) => left + right, 0);
    const raw = weights.map((weight) => (weight / sum) * (total - count));
    const shares = raw.map((value) => 1 + Math.floor(value));
    let remainder = total - shares.reduce((left, right) => left + right, 0);
    const order = raw.map((value, index) => [value - Math.floor(value), index]).sort((left, right) => right[0] - left[0] || left[1] - right[1]);
    for (let cursor = 0; remainder > 0; cursor = (cursor + 1) % count, remainder -= 1) shares[order[cursor][1]] += 1;
    return shares;
}

class Skeleton {
    constructor(templateEntry) {
        this.template = templateEntry;
        this.zones = [];
        this.nodes = [];
        this.services = [];
        this.volumes = [];
        this.routes = [];
        this.dependencies = [];
        this.counters = { service: 0, node: 0, volume: 0, route: 0 };
        this.layers = [];
        this.entries = [];
        this.databases = [];
        this.caches = [];
        this.queues = [];
    }

    addZone() {
        const zone = { id: zoneId(this.zones.length) };
        this.zones.push(zone);
        return zone.id;
    }

    addNode(zone, slots) {
        this.counters.node += 1;
        const node = { id: `node-${pad(this.counters.node)}`, zone, slots };
        this.nodes.push(node);
        return node.id;
    }

    addService(kind, rng, overrides = {}) {
        this.counters.service += 1;
        const replicas = overrides.replicas ?? (kind === SERVICE_KIND.DATABASE ? rng.range(1, 2) : range(rng, this.template.replicas));
        const service = {
            id: `svc-${pad(this.counters.service)}`,
            kind,
            replicas,
            minHealthy: overrides.minHealthy
                ?? (kind === SERVICE_KIND.DATABASE ? 1 : (rng.chance(0.3) ? replicas - 1 : Math.ceil(replicas / 2))),
            podCapacityRps: 1,
            startupMs: overrides.startupMs ?? 100 * rng.range(this.template.startupMs[0] / 100, this.template.startupMs[1] / 100),
            role: overrides.role ?? null,
            volume: null,
            queueCapacity: kind === SERVICE_KIND.QUEUE ? 1 : null,
            utilization: overrides.utilization ?? null,
        };
        if (service.minHealthy < 1) service.minHealthy = 1;
        this.services.push(service);
        return service.id;
    }

    addDatabase(rng, zone, overrides = {}) {
        const id = this.addService(SERVICE_KIND.DATABASE, rng, { role: 'primary', ...overrides });
        this.attachVolume(id, zone);
        return id;
    }

    attachVolume(serviceId, zone) {
        this.counters.volume += 1;
        const volume = { id: `vol-${pad(this.counters.volume)}`, zone, service: serviceId };
        this.volumes.push(volume);
        this.service(serviceId).volume = volume.id;
        return volume.id;
    }

    addRoute(sharePct, entry) {
        this.counters.route += 1;
        const route = { id: `route-${this.counters.route}`, sharePct, entry };
        this.routes.push(route);
        return route.id;
    }

    connect(type, from, to) {
        if (!this.dependencies.some((edge) => edge.type === type && edge.from === from && edge.to === to)) {
            this.dependencies.push({ type, from, to });
        }
    }

    service(id) {
        return this.services.find((service) => service.id === id);
    }

    volumeZone(serviceId) {
        const volume = this.volumes.find((candidate) => candidate.service === serviceId);
        return volume ? volume.zone : null;
    }
}

function sampleSkeleton(rng, templateEntry) {
    const skeleton = new Skeleton(templateEntry);
    const zones = range(rng, templateEntry.zones);
    for (let index = 0; index < zones; index += 1) {
        const zone = skeleton.addZone();
        const count = range(rng, templateEntry.nodesPerZone);
        for (let node = 0; node < count; node += 1) skeleton.addNode(zone, templateEntry.slots);
    }
    const zoneIds = skeleton.zones.map((zone) => zone.id);
    const databases = range(rng, templateEntry.databases);
    const caches = range(rng, templateEntry.caches);
    const queues = range(rng, templateEntry.queues);
    for (let index = 0; index < databases; index += 1) {
        const home = rng.pick(zoneIds);
        const primary = skeleton.addDatabase(rng, home);
        skeleton.databases.push(primary);
        if (rng.chance(templateEntry.replicaDatabaseProbability)) {
            const replica = skeleton.addService(SERVICE_KIND.DATABASE, rng, { role: 'replica' });
            skeleton.attachVolume(replica, rng.pick(zoneIds.filter((zone) => zone !== home)));
            skeleton.connect(RELATION.REPLICATES, primary, replica);
        }
    }
    for (let index = 0; index < caches; index += 1) {
        const cache = skeleton.addService(SERVICE_KIND.CACHE, rng);
        skeleton.caches.push(cache);
        skeleton.connect(RELATION.BACKED_BY, cache, rng.pick(skeleton.databases));
    }
    const workers = [];
    for (let index = 0; index < queues; index += 1) {
        const queue = skeleton.addService(SERVICE_KIND.QUEUE, rng);
        const worker = skeleton.addService(SERVICE_KIND.WORKER, rng);
        skeleton.queues.push(queue);
        workers.push(worker);
        skeleton.connect(RELATION.CONSUMES, worker, queue);
        if (rng.chance(0.8)) skeleton.connect(RELATION.WRITES, worker, rng.pick(skeleton.databases));
    }
    const depth = range(rng, templateEntry.depth);
    for (let layer = 0; layer < depth; layer += 1) {
        skeleton.layers.push(Array.from({ length: range(rng, templateEntry.mids) },
            () => skeleton.addService(SERVICE_KIND.API, rng)));
    }
    const routeCount = range(rng, templateEntry.routes);
    for (let index = 0; index < routeCount; index += 1) skeleton.entries.push(skeleton.addService(SERVICE_KIND.API, rng));
    const call = (from, to) => skeleton.connect(
        rng.chance(templateEntry.optionalProbability) ? RELATION.CALLS_OPTIONAL : RELATION.CALLS, from, to);
    for (const entry of skeleton.entries) {
        const targets = new Set(Array.from({ length: rng.range(1, 2) }, () => rng.pick(skeleton.layers[0])));
        for (const target of targets) call(entry, target);
    }
    for (let layer = 0; layer + 1 < skeleton.layers.length; layer += 1) {
        for (const service of skeleton.layers[layer]) {
            const count = rng.range(0, 2);
            for (let index = 0; index < count; index += 1) call(service, rng.pick(skeleton.layers[layer + 1]));
        }
        for (const service of skeleton.layers[layer + 1]) {
            if (!skeleton.dependencies.some((edge) => edge.to === service)) call(rng.pick(skeleton.layers[layer]), service);
        }
    }
    const readers = skeleton.databases.map((primary) => {
        const replica = skeleton.dependencies.find((edge) => edge.type === RELATION.REPLICATES && edge.from === primary);
        return replica ? replica.to : primary;
    });
    const last = skeleton.layers.length - 1;
    skeleton.layers.forEach((services, layer) => {
        for (const service of services) {
            if (layer !== last && !rng.chance(0.3)) continue;
            if (rng.chance(0.6)) skeleton.connect(RELATION.WRITES, service, rng.pick(skeleton.databases));
            if (rng.chance(0.5)) skeleton.connect(RELATION.READS, service, rng.pick(readers));
            if (skeleton.caches.length && rng.chance(0.5)) skeleton.connect(RELATION.READS_THROUGH, service, rng.pick(skeleton.caches));
            if (skeleton.queues.length && rng.chance(0.4)) skeleton.connect(RELATION.PUBLISHES, service, rng.pick(skeleton.queues));
        }
    });
    for (const cache of skeleton.caches) {
        if (!skeleton.dependencies.some((edge) => edge.type === RELATION.READS_THROUGH && edge.to === cache)) {
            skeleton.connect(RELATION.READS_THROUGH, rng.pick(skeleton.layers[last]), cache);
        }
    }
    for (const queue of skeleton.queues) {
        if (!skeleton.dependencies.some((edge) => edge.type === RELATION.PUBLISHES && edge.to === queue)) {
            skeleton.connect(RELATION.PUBLISHES, rng.pick(skeleton.layers[last]), queue);
        }
    }
    skeleton.baseRouteCount = routeCount;
    return skeleton;
}

// Base routes share whatever the motif routes leave (section 4.3 motifs add
// their own routes); `reserved` lists the motif shares already taken.
function assignBaseRoutes(rng, skeleton, reservedPct = 0) {
    const shares = composeShares(rng, skeleton.entries.length, 100 - reservedPct);
    skeleton.entries.forEach((entry, index) => skeleton.addRoute(shares[index], entry));
}

// The world carries static parameters only; the sampling-time utilization
// target stays in the skeleton.
function publicService(service) {
    const { id, kind, replicas, minHealthy, podCapacityRps, startupMs, role, volume, queueCapacity } = service;
    return { id, kind, replicas, minHealthy, podCapacityRps, startupMs, role, volume, queueCapacity };
}

function variantWorld(skeleton, variant, placement, rps) {
    return stable({
        schemaVersion: WORLD_SCHEMA_VERSION,
        kind: WORLD_KIND,
        template: skeleton.template.id,
        zones: skeleton.zones,
        nodes: skeleton.nodes,
        services: skeleton.services.map(publicService),
        volumes: skeleton.volumes,
        routes: variant?.routes || skeleton.routes,
        dependencies: variant?.dependencies || skeleton.dependencies,
        placement,
        traffic: { rps },
        errorBudgetPct: ERROR_BUDGET_PCT,
    });
}

/**
 * Size per-pod capacity and queue capacity from the healthy, warm
 * steady-state load, taking the maximum over every wiring variant so the
 * members of a pair share identical static features.
 */
function sizeCapacities(rng, skeleton, variants, rps, overrides = {}) {
    const placeholder = Object.fromEntries(skeleton.services.map((service) => [service.id,
        Array.from({ length: service.replicas }, () => skeleton.nodes[0].id)]));
    const loads = variants.map((variant) => {
        const world = variantWorld(skeleton, variant, placeholder, rps);
        return computeLoads(world);
    });
    for (const service of skeleton.services) {
        const peak = Math.max(...loads.map(({ load }) => load[service.id]));
        // Stores are sized for warm-cache traffic and run hotter than stateless tiers.
        const band = service.kind === SERVICE_KIND.DATABASE ? skeleton.template.databaseUtilization : skeleton.template.utilization;
        const utilization = overrides.utilization?.[service.id]
            ?? service.utilization
            ?? (range(rng, [band[0] * 100, band[1] * 100]) / 100);
        service.podCapacityRps = Math.max(10, Math.ceil(peak / (service.replicas * utilization)));
        if (service.kind === SERVICE_KIND.QUEUE) {
            const inflow = Math.max(...loads.map(({ inflow }) => inflow[service.id] || 0));
            const seconds = overrides.queueSeconds?.[service.id] ?? range(rng, skeleton.template.queueSeconds);
            service.queueCapacity = Math.max(10, Math.ceil(inflow * seconds));
        }
    }
    // Twins (motif services swapped between pair members) share one capacity.
    for (const group of overrides.groups || []) {
        const members = group.map((id) => skeleton.service(id));
        const capacity = Math.max(...members.map((service) => service.podCapacityRps));
        const queue = Math.max(...members.map((service) => service.queueCapacity || 0));
        for (const service of members) {
            service.podCapacityRps = capacity;
            if (service.kind === SERVICE_KIND.QUEUE) service.queueCapacity = queue;
        }
    }
}

// Placement policies: spread over zones and nodes, pack in node order, or
// uniformly at random; databases stay in their volume's zone and `pinned`
// placements (motif pods on dedicated nodes) are honoured first.
function placePods(rng, skeleton, pinned = {}) {
    const policy = rng.pick(['spread', 'pack', 'random']);
    const used = new Map(skeleton.nodes.map((node) => [node.id, 0]));
    const placement = {};
    for (const [serviceId, nodes] of Object.entries(pinned)) {
        placement[serviceId] = nodes.slice();
        for (const node of nodes) used.set(node, used.get(node) + 1);
    }
    const dedicated = new Set(Object.values(pinned).flat());
    for (const service of skeleton.services) {
        const already = placement[service.id] || [];
        const zone = skeleton.volumeZone(service.id);
        for (let replica = already.length; replica < service.replicas; replica += 1) {
            let candidates = skeleton.nodes.filter((node) => (
                !dedicated.has(node.id) && used.get(node.id) < node.slots && (!zone || node.zone === zone)
            ));
            if (!candidates.length) {
                const home = zone || rng.pick(skeleton.zones).id;
                const added = skeleton.addNode(home, skeleton.template.slots);
                candidates = [skeleton.nodes.find((node) => node.id === added)];
                used.set(added, 0);
            }
            let chosen;
            if (policy === 'pack') chosen = candidates[0];
            else if (policy === 'random') chosen = rng.pick(candidates);
            else {
                const onService = new Map();
                for (const node of already) onService.set(node, (onService.get(node) || 0) + 1);
                chosen = candidates.slice().sort((left, right) => (
                    (onService.get(left.id) || 0) - (onService.get(right.id) || 0)
                    || used.get(left.id) - used.get(right.id)
                    || left.id.localeCompare(right.id)
                ))[0];
            }
            already.push(chosen.id);
            used.set(chosen.id, used.get(chosen.id) + 1);
        }
        placement[service.id] = already;
    }
    // Keep one free slot per zone-worth of pods for rescheduling headroom.
    const pods = skeleton.services.reduce((sum, service) => sum + service.replicas, 0);
    const slots = skeleton.nodes.reduce((sum, node) => sum + node.slots, 0);
    for (let extra = 0; slots + extra * skeleton.template.slots < Math.ceil(pods * 1.5); extra += 1) {
        skeleton.addNode(skeleton.zones[extra % skeleton.zones.length].id, skeleton.template.slots);
    }
    return { policy, placement };
}

function generateWorld(seed, templateId, { rps = 1000 } = {}) {
    const rng = new Rng((seed ^ 0x5bd1e995) >>> 0);
    const skeleton = sampleSkeleton(rng, template(templateId));
    assignBaseRoutes(rng, skeleton);
    sizeCapacities(rng, skeleton, [null], rps);
    const { placement, policy } = placePods(rng, skeleton);
    const world = variantWorld(skeleton, null, placement, rps);
    validateWorld(world);
    return { world, placementPolicy: policy, seed, template: templateId };
}

/**
 * Outcome-blind natural schedule (section 6): a warm-up, then 30-80 steps
 * from one hazard process. Fault types and targets are uniform over what the
 * world contains; nothing reads the outcome.
 */
function naturalSchedule(seed, world) {
    const rng = new Rng((seed ^ 0x27d4eb2f) >>> 0);
    const hazard = rng.range(1, 6) / 100;
    const operations = 0.15;
    const caches = world.services.filter((service) => service.kind === SERVICE_KIND.CACHE).map((service) => service.id);
    const workers = world.services.filter((service) => service.kind === SERVICE_KIND.WORKER).map((service) => service.id);
    const scalable = world.services.filter((service) => service.kind !== SERVICE_KIND.DATABASE).map((service) => service.id);
    const nodes = world.nodes.map((node) => node.id);
    const zones = world.zones.map((zone) => zone.id);
    const pods = world.services.flatMap((service) => world.placement[service.id].map((_, index) => `pod/${service.id}-${index + 1}`));
    const faults = [
        () => ({ type: MESH_FAULT.NODE_CRASH, nodeId: rng.pick(nodes) }),
        () => ({ type: MESH_FAULT.ZONE_DEGRADED, zoneId: rng.pick(zones) }),
        () => ({ type: MESH_FAULT.POD_CRASH, podId: rng.pick(pods) }),
        () => ({ type: MESH_FAULT.TRAFFIC_SPIKE, factor: rng.range(11, 16) / 10 }),
        ...(caches.length ? [() => ({ type: MESH_FAULT.CACHE_FLUSH, serviceId: rng.pick(caches) })] : []),
        ...(workers.length ? [() => ({ type: MESH_FAULT.CONSUMER_STALL, serviceId: rng.pick(workers),
            durationMs: 100 * rng.range(10, 60) })] : []),
    ];
    const ops = [
        () => ({ type: MESH_ACTION.SCALE, serviceId: rng.pick(scalable), replicas: rng.range(2, 6) }),
        () => ({ type: MESH_ACTION.TRAFFIC_SHIFT, rps: 100 * rng.range(6, 14) }),
        () => ({ type: MESH_ACTION.DRAIN_NODE, nodeId: rng.pick(nodes) }),
        () => ({ type: MESH_ACTION.UNCORDON_NODE, nodeId: rng.pick(nodes) }),
        () => ({ type: MESH_ACTION.RECOVER_NODE, nodeId: rng.pick(nodes) }),
        () => ({ type: MESH_ACTION.RECOVER_ZONE, zoneId: rng.pick(zones) }),
    ];
    const actions = [{ type: MESH_ACTION.ADVANCE_TIME, ms: 100 * rng.range(3, 10) }];
    const length = rng.range(30, 80);
    for (let index = 0; index < length; index += 1) {
        const roll = rng.float();
        if (roll < hazard) actions.push(rng.pick(faults)());
        else if (roll < hazard + operations) actions.push(rng.pick(ops)());
        else actions.push({ type: MESH_ACTION.ADVANCE_TIME, ms: 100 * rng.range(1, 15) });
    }
    return { actions, hazard };
}

module.exports = {
    Skeleton,
    TEMPLATES,
    assignBaseRoutes,
    composeShares,
    generateWorld,
    naturalSchedule,
    placePods,
    sampleSkeleton,
    sizeCapacities,
    template,
    variantWorld,
};
