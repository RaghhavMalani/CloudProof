'use strict';

// World specification, validation and request-flow computation for CloudProof
// Mesh (CLOUDPROOF-PHASE-III-MULTISERVICE.md, section 3).

const { digest } = require('../agent-runtime');
const {
    DEPENDENCY_ENDPOINTS,
    ERROR_BUDGET_PCT,
    RELATION,
    SERVICE_KIND,
} = require('./constants');

const WORLD_KIND = 'cloudproof.mesh-world';
const WORLD_SCHEMA_VERSION = 1;

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function indexById(items, label) {
    const map = new Map();
    for (const item of items) {
        if (!item || typeof item.id !== 'string' || !item.id) throw new TypeError(`${label} requires string ids`);
        if (map.has(item.id)) throw new TypeError(`duplicate ${label} id: ${item.id}`);
        map.set(item.id, item);
    }
    return map;
}

function integerIn(value, name, minimum, maximum = Infinity) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(`${name} must be an integer in [${minimum}, ${maximum}]`);
    }
}

// Request flow runs from routes towards storage. CONSUMES is written
// worker -> queue but messages flow queue -> worker, so it is reversed here.
function flowEdges(world) {
    return world.dependencies.map((edge) => (
        edge.type === RELATION.CONSUMES ? [edge.to, edge.from] : [edge.from, edge.to]
    ));
}

// Kahn's algorithm with ID tie-breaks: sources first, deterministic.
function flowOrder(world) {
    const ids = world.services.map((service) => service.id).sort();
    const indegree = new Map(ids.map((id) => [id, 0]));
    const next = new Map(ids.map((id) => [id, []]));
    for (const [from, to] of flowEdges(world)) {
        next.get(from).push(to);
        indegree.set(to, indegree.get(to) + 1);
    }
    const ready = ids.filter((id) => indegree.get(id) === 0);
    const order = [];
    while (ready.length) {
        ready.sort();
        const id = ready.shift();
        order.push(id);
        for (const to of next.get(id)) {
            indegree.set(to, indegree.get(to) - 1);
            if (indegree.get(to) === 0) ready.push(to);
        }
    }
    if (order.length !== ids.length) throw new TypeError('service dependencies must form a directed acyclic graph');
    return order;
}

function outgoing(world, serviceId, type = null) {
    return world.dependencies.filter((edge) => edge.from === serviceId && (!type || edge.type === type));
}

function incoming(world, serviceId, type = null) {
    return world.dependencies.filter((edge) => edge.to === serviceId && (!type || edge.type === type));
}

function backingOf(world, cacheId) {
    return outgoing(world, cacheId, RELATION.BACKED_BY)[0]?.to || null;
}

function replicaOf(world, primaryId) {
    return outgoing(world, primaryId, RELATION.REPLICATES)[0]?.to || null;
}

function primaryOf(world, replicaId) {
    return incoming(world, replicaId, RELATION.REPLICATES)[0]?.from || null;
}

function validateWorld(world) {
    if (!world || world.kind !== WORLD_KIND || world.schemaVersion !== WORLD_SCHEMA_VERSION) {
        throw new TypeError(`expected a ${WORLD_KIND} v${WORLD_SCHEMA_VERSION}`);
    }
    const zones = indexById(world.zones, 'zone');
    const nodes = indexById(world.nodes, 'node');
    const services = indexById(world.services, 'service');
    const volumes = indexById(world.volumes, 'volume');
    indexById(world.routes, 'route');
    for (const node of world.nodes) {
        if (!zones.has(node.zone)) throw new TypeError(`${node.id} references unknown zone ${node.zone}`);
        integerIn(node.slots, `${node.id}.slots`, 1, 64);
    }
    for (const service of world.services) {
        if (!Object.values(SERVICE_KIND).includes(service.kind)) throw new TypeError(`${service.id} has unknown kind`);
        integerIn(service.replicas, `${service.id}.replicas`, 1, 64);
        integerIn(service.minHealthy, `${service.id}.minHealthy`, 1, service.replicas);
        integerIn(service.podCapacityRps, `${service.id}.podCapacityRps`, 1);
        integerIn(service.startupMs, `${service.id}.startupMs`, 0, 60_000);
        if (service.kind === SERVICE_KIND.DATABASE) {
            if (!['primary', 'replica'].includes(service.role)) throw new TypeError(`${service.id} needs a database role`);
            const volume = volumes.get(service.volume);
            if (!volume || volume.service !== service.id) throw new TypeError(`${service.id} needs its own volume`);
        } else if (service.role !== null || service.volume !== null) {
            throw new TypeError(`${service.id}: only databases carry a role and a volume`);
        }
        if (service.kind === SERVICE_KIND.QUEUE) integerIn(service.queueCapacity, `${service.id}.queueCapacity`, 1);
        else if (service.queueCapacity !== null) throw new TypeError(`${service.id}: only queues carry a capacity`);
    }
    for (const volume of world.volumes) {
        if (!zones.has(volume.zone)) throw new TypeError(`${volume.id} references unknown zone`);
        if (services.get(volume.service)?.kind !== SERVICE_KIND.DATABASE) {
            throw new TypeError(`${volume.id} must belong to a database`);
        }
    }
    let shares = 0;
    for (const route of world.routes) {
        integerIn(route.sharePct, `${route.id}.sharePct`, 1, 100);
        if (services.get(route.entry)?.kind !== SERVICE_KIND.API) throw new TypeError(`${route.id} must enter an api`);
        shares += route.sharePct;
    }
    if (shares !== 100) throw new TypeError(`route shares must sum to 100, not ${shares}`);
    const seen = new Set();
    for (const edge of world.dependencies) {
        const endpoints = DEPENDENCY_ENDPOINTS[edge.type];
        if (!endpoints) throw new TypeError(`unknown dependency type ${edge.type}`);
        const from = services.get(edge.from);
        const to = services.get(edge.to);
        if (!from || !to) throw new TypeError(`${edge.type} references an unknown service`);
        if (edge.from === edge.to) throw new TypeError(`${edge.type} self-loop on ${edge.from}`);
        if (!endpoints[0].includes(from.kind) || !endpoints[1].includes(to.kind)) {
            throw new TypeError(`${edge.type} cannot connect ${from.kind} to ${to.kind}`);
        }
        const key = `${edge.type}|${edge.from}|${edge.to}`;
        if (seen.has(key)) throw new TypeError(`duplicate dependency ${key}`);
        seen.add(key);
        if (edge.type === RELATION.REPLICATES && (from.role !== 'primary' || to.role !== 'replica')) {
            throw new TypeError('REPLICATES must run from a primary to a replica');
        }
    }
    for (const service of world.services) {
        if (service.kind === SERVICE_KIND.CACHE && outgoing(world, service.id, RELATION.BACKED_BY).length !== 1) {
            throw new TypeError(`${service.id} must be backed by exactly one database`);
        }
        if (service.role === 'replica' && incoming(world, service.id, RELATION.REPLICATES).length > 1) {
            throw new TypeError(`${service.id} replicates more than one primary`);
        }
    }
    flowOrder(world);
    const used = new Map();
    for (const service of world.services) {
        const placement = world.placement[service.id];
        if (!Array.isArray(placement) || placement.length !== service.replicas) {
            throw new TypeError(`${service.id} needs one node per replica`);
        }
        const volumeZone = service.volume ? volumes.get(service.volume).zone : null;
        for (const nodeId of placement) {
            const node = nodes.get(nodeId);
            if (!node) throw new TypeError(`${service.id} placed on unknown node ${nodeId}`);
            if (volumeZone && node.zone !== volumeZone) throw new TypeError(`${service.id} placed outside its volume zone`);
            used.set(nodeId, (used.get(nodeId) || 0) + 1);
        }
    }
    for (const [nodeId, count] of used) {
        if (count > nodes.get(nodeId).slots) throw new TypeError(`${nodeId} holds ${count} pods over its slots`);
    }
    if (!(world.traffic?.rps > 0)) throw new TypeError('traffic.rps must be positive');
    if (world.errorBudgetPct !== ERROR_BUDGET_PCT) throw new TypeError(`error budget is fixed at ${ERROR_BUDGET_PCT}%`);
    return true;
}

function worldDigest(world) {
    return digest({ kind: WORLD_KIND, world: stable(world) });
}

/**
 * Request load per service, from the routes down through the dependency
 * graph, with every edge at fan-out 1 (section 3.3, rule 4).
 *
 * `status` resolves runtime facts; the defaults describe a fully healthy,
 * warm world, which is what the generator sizes capacities against.
 */
function computeLoads(world, status = {}) {
    const up = status.intrinsicUp || (() => true);
    const missRatio = status.missRatio || (() => 0.2);
    const writeTarget = status.writeTarget || ((id) => id);
    const readTarget = status.readTarget || ((id) => id);
    const consuming = status.consuming || ((id) => up(id));
    const rps = status.rps ?? world.traffic.rps;
    const load = Object.fromEntries(world.services.map((service) => [service.id, 0]));
    const inflow = {};
    for (const route of world.routes) load[route.entry] += (route.sharePct / 100) * rps;
    const byId = new Map(world.services.map((service) => [service.id, service]));
    for (const id of flowOrder(world)) {
        const service = byId.get(id);
        if (!up(id)) continue;
        if (service.kind === SERVICE_KIND.CACHE) {
            const backing = backingOf(world, id);
            if (backing) load[writeTarget(backing)] += load[id] * missRatio(id);
            continue;
        }
        if (service.kind === SERVICE_KIND.QUEUE) {
            const consumers = incoming(world, id, RELATION.CONSUMES).map((edge) => edge.from).filter(consuming);
            for (const consumer of consumers) load[consumer] += (inflow[id] || 0) / consumers.length;
            continue;
        }
        for (const edge of outgoing(world, id)) {
            if (edge.type === RELATION.CALLS || edge.type === RELATION.CALLS_OPTIONAL) load[edge.to] += load[id];
            else if (edge.type === RELATION.WRITES) load[writeTarget(edge.to)] += load[id];
            else if (edge.type === RELATION.READS) load[readTarget(edge.to)] += load[id];
            else if (edge.type === RELATION.READS_THROUGH) {
                if (up(edge.to)) load[edge.to] += load[id];
                else load[writeTarget(backingOf(world, edge.to))] += load[id];
            } else if (edge.type === RELATION.PUBLISHES) {
                inflow[edge.to] = (inflow[edge.to] || 0) + load[id];
                load[edge.to] += load[id];
            }
        }
    }
    return { load, inflow };
}

module.exports = {
    WORLD_KIND,
    WORLD_SCHEMA_VERSION,
    backingOf,
    clone,
    computeLoads,
    flowOrder,
    incoming,
    outgoing,
    primaryOf,
    replicaOf,
    stable,
    validateWorld,
    worldDigest,
};
