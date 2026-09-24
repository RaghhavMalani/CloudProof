'use strict';

// Closed vocabularies of the CloudProof Mesh world (Phase III). The Phase I-II
// single-service twin in packages/cloudproof is deliberately left untouched.

const NODE_TYPE = Object.freeze({
    ZONE: 'Zone',
    NODE: 'Node',
    POD: 'Pod',
    SERVICE: 'Service',
    ROUTE: 'Route',
    VOLUME: 'Volume',
});

const RELATION = Object.freeze({
    LOCATED_IN: 'LOCATED_IN',
    RUNS_ON: 'RUNS_ON',
    OWNS: 'OWNS',
    MOUNTS: 'MOUNTS',
    ENTERS: 'ENTERS',
    CALLS: 'CALLS',
    CALLS_OPTIONAL: 'CALLS_OPTIONAL',
    READS_THROUGH: 'READS_THROUGH',
    BACKED_BY: 'BACKED_BY',
    WRITES: 'WRITES',
    READS: 'READS',
    REPLICATES: 'REPLICATES',
    PUBLISHES: 'PUBLISHES',
    CONSUMES: 'CONSUMES',
});

const RELATION_TYPES = Object.freeze(Object.values(RELATION));

const SERVICE_KIND = Object.freeze({
    API: 'api',
    CACHE: 'cache',
    QUEUE: 'queue',
    WORKER: 'worker',
    DATABASE: 'database',
});

// Service-to-service relations and the service kinds each may connect.
const DEPENDENCY_ENDPOINTS = Object.freeze({
    CALLS: [['api', 'worker'], ['api']],
    CALLS_OPTIONAL: [['api', 'worker'], ['api']],
    READS_THROUGH: [['api', 'worker'], ['cache']],
    BACKED_BY: [['cache'], ['database']],
    WRITES: [['api', 'worker'], ['database']],
    READS: [['api', 'worker'], ['database']],
    REPLICATES: [['database'], ['database']],
    PUBLISHES: [['api', 'worker'], ['queue']],
    CONSUMES: [['worker'], ['queue']],
});

const POD_PHASE = Object.freeze({
    RUNNING: 'RUNNING',
    STARTING: 'STARTING',
    PENDING: 'PENDING',
    FAILED: 'FAILED',
});

const MESH_ACTION = Object.freeze({
    ADVANCE_TIME: 'mesh.action.advance-time',
    SCALE: 'mesh.action.scale',
    TRAFFIC_SHIFT: 'mesh.action.traffic-shift',
    DRAIN_NODE: 'mesh.action.drain-node',
    UNCORDON_NODE: 'mesh.action.uncordon-node',
    RECOVER_NODE: 'mesh.action.recover-node',
    RECOVER_ZONE: 'mesh.action.recover-zone',
});

const MESH_FAULT = Object.freeze({
    NODE_CRASH: 'mesh.fault.node-crash',
    ZONE_DEGRADED: 'mesh.fault.zone-degraded',
    POD_CRASH: 'mesh.fault.pod-crash',
    CACHE_FLUSH: 'mesh.fault.cache-flush',
    CONSUMER_STALL: 'mesh.fault.consumer-stall',
    TRAFFIC_SPIKE: 'mesh.fault.traffic-spike',
});

const ACTION_TYPES = Object.freeze([...Object.values(MESH_ACTION), ...Object.values(MESH_FAULT)]);

const INCIDENT_CLASS = Object.freeze({
    INSTANCE_LOSS: 'INSTANCE_LOSS',
    STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
    OVERLOAD: 'OVERLOAD',
    CACHE_STAMPEDE: 'CACHE_STAMPEDE',
    QUEUE_BACKPRESSURE: 'QUEUE_BACKPRESSURE',
});

// Section 3.3 of CLOUDPROOF-PHASE-III-MULTISERVICE.md.
const TIMING = Object.freeze({
    tickMs: 100,
    evictionDelayMs: 2000,
    rescheduleDelayMs: 800,
    cacheWarmupMs: 3000,
    failoverDelayMs: 1500,
});

const CACHE_MISS_RATIO = Object.freeze({ warm: 0.2, cold: 1.0 });

// Route error budget, in percent of traffic share.
const ERROR_BUDGET_PCT = 20;

const SLO_INVARIANT = 'mesh.slo.route-error-budget';

module.exports = {
    ACTION_TYPES,
    CACHE_MISS_RATIO,
    DEPENDENCY_ENDPOINTS,
    ERROR_BUDGET_PCT,
    INCIDENT_CLASS,
    MESH_ACTION,
    MESH_FAULT,
    NODE_TYPE,
    POD_PHASE,
    RELATION,
    RELATION_TYPES,
    SERVICE_KIND,
    SLO_INVARIANT,
    TIMING,
};
