'use strict';

// Topology import for the Operations Console.
//
// Two inputs are accepted, and nothing else is claimed:
//  - a CloudProof Mesh world (`kind: "cloudproof.mesh-world"`, v1), exactly as
//    packages/cloudproof-mesh/world.js validates it;
//  - a simplified topology (`kind: "cloudproof.topology"`, v1), documented by
//    `toSimplified()` (the example download), which is converted to a mesh world.
// Arbitrary Kubernetes YAML is not supported.

const { RELATION_TYPES, SERVICE_KIND } = require('../cloudproof-mesh/constants');
const { createMeshState } = require('../cloudproof-mesh/engine');
const { WORLD_KIND, validateWorld } = require('../cloudproof-mesh/world');

const TOPOLOGY_KIND = 'cloudproof.topology';

function describeJsonError(text, error) {
    const match = /position (\d+)/.exec(error.message);
    if (!match) return `Not valid JSON: ${error.message}`;
    const position = Number(match[1]);
    const before = text.slice(0, position);
    const line = before.split('\n').length;
    const column = position - before.lastIndexOf('\n');
    return `Not valid JSON at line ${line}, column ${column}: ${error.message.replace(/ in JSON at position \d+.*/, '')}`;
}

// Turn the validator's terse messages into sentences a person can act on.
function humanize(message) {
    return message
        .replace(/^expected a cloudproof\.mesh-world v1$/, 'The document is not a CloudProof mesh world (kind "cloudproof.mesh-world", schemaVersion 1).')
        .replace(/must be an integer in \[(\d+), (Infinity|\d+)\]/, (_, low, high) => (high === 'Infinity' ? `must be a whole number of at least ${low}` : `must be a whole number between ${low} and ${high}`))
        .replace(/^(\S+) needs one node per replica$/, '$1: its placement must list exactly one node per replica.')
        .replace(/^(\S+) placed outside its volume zone$/, '$1: a database pod must run in the same zone as its volume.')
        .replace(/^service dependencies must form a directed acyclic graph$/, 'Service dependencies contain a cycle; requests must flow one way.');
}

function slug(value) {
    return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
}

/** Convert the simplified format into a mesh world, collecting every problem. */
function fromSimplified(input, errors) {
    const zones = input.zones && typeof input.zones === 'object' && !Array.isArray(input.zones) ? input.zones : null;
    if (!zones || !Object.keys(zones).length) errors.push('"zones" must map each zone id to a list of node ids, e.g. {"zone-a": ["node-a1"]}.');
    const nodes = [];
    for (const [zone, list] of Object.entries(zones || {})) {
        if (!slug(zone)) errors.push(`Zone id "${zone}" must be lowercase letters, digits and dashes.`);
        if (!Array.isArray(list) || !list.length) { errors.push(`Zone "${zone}" needs at least one node.`); continue; }
        for (const node of list) {
            const id = typeof node === 'string' ? node : node?.id;
            if (!slug(id)) { errors.push(`Node "${id}" in ${zone} must be lowercase letters, digits and dashes.`); continue; }
            nodes.push({ id, zone, slots: Number.isInteger(node?.slots) ? node.slots : 8 });
        }
    }
    if (!Array.isArray(input.services) || !input.services.length) errors.push('"services" must be a non-empty list.');
    const services = [];
    const volumes = [];
    const placement = {};
    for (const item of input.services || []) {
        if (!slug(item?.id)) { errors.push(`Service id "${item?.id}" must be lowercase letters, digits and dashes.`); continue; }
        if (!Object.values(SERVICE_KIND).includes(item.kind)) {
            errors.push(`Service "${item.id}": kind must be one of ${Object.values(SERVICE_KIND).join(', ')}.`);
            continue;
        }
        const replicas = item.replicas ?? 1;
        const service = {
            id: item.id,
            kind: item.kind,
            replicas,
            minHealthy: item.minHealthy ?? Math.ceil(replicas / 2),
            podCapacityRps: item.capacityRps,
            startupMs: item.startupMs ?? 1000,
            role: null,
            volume: null,
            queueCapacity: item.kind === SERVICE_KIND.QUEUE ? item.queueCapacity : null,
        };
        if (!Number.isInteger(item.capacityRps) || item.capacityRps < 1) errors.push(`Service "${item.id}": capacityRps (per pod) must be a positive whole number.`);
        if (item.kind === SERVICE_KIND.QUEUE && !(Number.isInteger(item.queueCapacity) && item.queueCapacity > 0)) {
            errors.push(`Queue "${item.id}": queueCapacity (messages) must be a positive whole number.`);
        }
        if (!Array.isArray(item.placement)) errors.push(`Service "${item.id}": placement must list one node id per replica.`);
        placement[item.id] = Array.isArray(item.placement) ? item.placement.slice() : [];
        if (item.kind === SERVICE_KIND.DATABASE) {
            service.role = item.role || 'primary';
            const firstNode = nodes.find((node) => node.id === placement[item.id][0]);
            const zone = item.zone || firstNode?.zone;
            if (!zone) errors.push(`Database "${item.id}": give it a "zone" (where its volume lives) or a placement.`);
            service.volume = `vol-${item.id}`;
            volumes.push({ id: service.volume, zone, service: item.id });
        }
        services.push(service);
    }
    const routes = Array.isArray(input.routes) ? input.routes.map((route) => ({ id: route?.id, sharePct: route?.sharePct, entry: route?.entry })) : [];
    if (!routes.length) errors.push('"routes" must list at least one route: {"id", "sharePct", "entry"}.');
    const dependencies = [];
    for (const edge of input.dependencies || []) {
        const [from, type, to] = Array.isArray(edge) ? edge : [edge?.from, edge?.type, edge?.to];
        if (!RELATION_TYPES.includes(type)) { errors.push(`Dependency ${JSON.stringify(edge)}: type must be one of CALLS, CALLS_OPTIONAL, READS_THROUGH, BACKED_BY, WRITES, READS, REPLICATES, PUBLISHES, CONSUMES.`); continue; }
        dependencies.push({ type, from, to });
    }
    return {
        schemaVersion: 1,
        kind: WORLD_KIND,
        template: `import:${slug(input.name) ? input.name : 'custom'}`,
        zones: Object.keys(zones || {}).map((id) => ({ id })),
        nodes,
        services,
        volumes,
        routes,
        dependencies,
        placement,
        traffic: { rps: input.trafficRps ?? 1000 },
        errorBudgetPct: 20,
    };
}

/**
 * Parse and validate pasted text. Returns { ok, world, format, errors,
 * warnings }; errors are complete sentences.
 */
function parseTopology(text) {
    const trimmed = String(text).trim();
    if (/^(apiVersion|kind)\s*:/m.test(trimmed) && !trimmed.startsWith('{')) {
        return { ok: false, errors: ['This looks like Kubernetes YAML, which is not supported. Paste CloudProof topology JSON instead (download the example to start).'], warnings: [] };
    }
    let input;
    try {
        input = JSON.parse(text);
    } catch (error) {
        return { ok: false, errors: [describeJsonError(String(text), error)], warnings: [] };
    }
    const errors = [];
    const warnings = [];
    let world;
    let format;
    if (input?.kind === WORLD_KIND) {
        format = 'mesh-world';
        world = input;
    } else if (input?.kind === TOPOLOGY_KIND) {
        format = 'topology';
        if (input.version !== 1) errors.push(`Unsupported cloudproof.topology version ${input.version}; expected 1.`);
        world = fromSimplified(input, errors);
    } else {
        return {
            ok: false,
            errors: [`Unrecognised document. Expected "kind": "${TOPOLOGY_KIND}" (simplified format, see the example) or "${WORLD_KIND}". Kubernetes manifests are not supported.`],
            warnings,
        };
    }
    if (!errors.length) {
        try {
            validateWorld(world);
        } catch (error) {
            errors.push(humanize(error.message));
        }
    }
    if (!errors.length) {
        const state = createMeshState(world);
        const overloaded = Object.entries(state.derived.health).filter(([, health]) => health.overloaded).map(([id]) => id);
        const down = Object.entries(state.derived.health).filter(([, health]) => !health.up).map(([id]) => id);
        if (state.derived.violating) {
            errors.push(`At steady state ${state.derived.errorSharePct}% of traffic already fails (over the 20% budget)${overloaded.length ? `; overloaded: ${overloaded.join(', ')}` : ''}. Raise capacities before verifying changes.`);
        } else if (down.length) {
            warnings.push(`Unavailable at steady state: ${down.join(', ')}.`);
        }
    }
    return errors.length ? { ok: false, errors, warnings, format } : { ok: true, world, format, errors: [], warnings };
}

/** The simplified form of a mesh world (used for the example download). */
function toSimplified(world, name = 'example') {
    return {
        kind: TOPOLOGY_KIND,
        version: 1,
        name,
        trafficRps: world.traffic.rps,
        zones: Object.fromEntries(world.zones.map((zone) => [zone.id,
            world.nodes.filter((node) => node.zone === zone.id).map((node) => (node.slots === 8 ? node.id : { id: node.id, slots: node.slots }))])),
        services: world.services.map((service) => ({
            id: service.id,
            kind: service.kind,
            replicas: service.replicas,
            minHealthy: service.minHealthy,
            capacityRps: service.podCapacityRps,
            startupMs: service.startupMs,
            ...(service.role ? { role: service.role, zone: world.volumes.find((volume) => volume.id === service.volume).zone } : {}),
            ...(service.queueCapacity ? { queueCapacity: service.queueCapacity } : {}),
            placement: world.placement[service.id],
        })),
        routes: world.routes,
        dependencies: world.dependencies.map((edge) => [edge.from, edge.type, edge.to]),
    };
}

/** Default invariants for an imported world: the busiest route and the budget. */
function defaultInvariants(world) {
    const busiest = world.routes.slice().sort((left, right) => right.sharePct - left.sharePct || left.id.localeCompare(right.id))[0];
    return [
        { id: `route-${busiest.id}`, kind: 'route-available', route: busiest.id },
        { id: 'error-budget', kind: 'error-budget', maxPct: 20 },
    ];
}

module.exports = { TOPOLOGY_KIND, defaultInvariants, parseTopology, toSimplified };
