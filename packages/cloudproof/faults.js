'use strict';

const CLOUD_FAULT = Object.freeze({
    NODE_CRASH: 'cloud.fault.node-crash',
    NODE_DRAIN: 'cloud.fault.node-drain',
    ZONE_DEGRADED: 'cloud.fault.zone-degraded',
    READINESS_DELAY: 'cloud.fault.readiness-delay',
    IMAGE_PULL_DELAY: 'cloud.fault.image-pull-delay',
    HPA_STALE_METRIC: 'cloud.fault.hpa-stale-metric',
    ENDPOINT_PROPAGATION_DELAY: 'cloud.fault.endpoint-propagation-delay',
    CONTROLLER_RESTART: 'cloud.fault.controller-restart',
});

const CLOUD_ACTION = Object.freeze({
    ROLL_OUT: 'cloud.action.roll-out',
    ROLL_BACK: 'cloud.action.roll-back',
    SCALE: 'cloud.action.scale',
    DRAIN_NODE: 'cloud.action.drain-node',
    RECOVER_NODE: 'cloud.action.recover-node',
    ADVANCE_TIME: 'cloud.action.advance-time',
    TRAFFIC_SPIKE: 'cloud.action.traffic-spike',
});

const CONTROLLER_ACTION = Object.freeze({
    DEPLOYMENT: 'cloud.controller.deployment',
    SCHEDULER: 'cloud.controller.scheduler',
    KUBELET: 'cloud.controller.kubelet',
    ENDPOINTS: 'cloud.controller.endpoints',
    HPA: 'cloud.controller.hpa',
    PDB: 'cloud.controller.pdb',
    YIELD: 'cloud.scheduler.yield',
});

const FAULT_TYPES = Object.freeze(Object.values(CLOUD_FAULT));
const ACTION_TYPES = Object.freeze(Object.values(CLOUD_ACTION));
const CONTROLLER_TYPES = Object.freeze(Object.values(CONTROLLER_ACTION));

module.exports = {
    ACTION_TYPES,
    CLOUD_ACTION,
    CLOUD_FAULT,
    CONTROLLER_ACTION,
    CONTROLLER_TYPES,
    FAULT_TYPES,
};
