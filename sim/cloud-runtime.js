'use strict';

const { digest } = require('../packages/agent-runtime');
const {
    applyEndpointSnapshot,
    reconcileDeployment,
    reconcileEndpoints,
    reconcileHpa,
    terminatePod,
    voluntaryDisruptionAllowed,
} = require('../packages/cloudproof/controllers');
const { evaluateCloudInvariants } = require('../packages/cloudproof/invariants');
const { POD_PHASE } = require('../packages/cloudproof/resources');
const {
    byId,
    canonicalState,
    clone,
    createCloudState,
    createFlagshipState,
    getDeployment,
    getHpa,
    getService,
    isActivePod,
    recomputeObserved,
} = require('../packages/cloudproof/state');
const { TransitionTelemetry } = require('../packages/cloudproof/telemetry');
const { scheduleOne } = require('../packages/cloudproof/scheduler');
const { Rng, VirtualClock } = require('./simulator');
const {
    CLOUD_ACTION,
    CLOUD_FAULT,
    CONTROLLER_ACTION,
    clone: cloneAction,
    validateCloudSchedule,
} = require('./cloud-actions');
const { getCloudMutant } = require('./cloud-mutants');

class CloudRuntimeSimulation {
    constructor({ seed = 1337, mutant = 'correct', topology = null, traffic = null,
        horizonTransitions = null } = {}) {
        this.state = topology
            ? createCloudState({ seed, topology, traffic: traffic || {} })
            : createFlagshipState({ seed });
        this.clock = new VirtualClock(0);
        this.rng = new Rng(seed);
        this.mutant = getCloudMutant(mutant);
        this.telemetry = new TransitionTelemetry({ horizonMs: 1000, horizonTransitions });
        this.trace = [];
        this.sequence = 0;
        this.timerSequence = 0;
        this.firstFailure = null;
    }

    _transition(action, mutation, metadata = {}) {
        const before = canonicalState(this.state);
        const outcome = mutation() || null;
        this.state.clockMs = this.clock.now();
        recomputeObserved(this.state);
        const evaluated = this.telemetry.capture(before, action, canonicalState(this.state), {
            ...metadata,
            outcome,
        });
        if (!this.firstFailure && evaluated.failure) this.firstFailure = clone(evaluated.failure);
        this.trace.push({
            sequence: ++this.sequence,
            atMs: this.state.clockMs,
            action: clone(action),
            outcome: clone(outcome),
            failure: clone(evaluated.failure),
        });
        return outcome;
    }

    _timer(type, delayMs, mutation, data = {}) {
        const timerId = `cloud-timer-${++this.timerSequence}`;
        this.clock.setTimeout(() => this._transition({
            id: timerId,
            type,
            atMs: this.clock.now(),
            ...clone(data),
        }, mutation, { source: 'virtual-clock' }), delayMs);
        return timerId;
    }

    _scheduleTermination(pod) {
        if (!pod || pod.terminationTimerScheduled) return;
        pod.terminationTimerScheduled = true;
        this._timer('cloud.kubelet.pod-terminated', 300, () => {
            const current = this.state.resources.pods.find((candidate) => candidate.id === pod.id);
            if (!current || current.phase !== POD_PHASE.TERMINATING) return { removed: false };
            current.phase = POD_PHASE.FAILED;
            current.nodeId = null;
            return { removed: true, podId: current.id };
        }, { podId: pod.id });
    }

    _schedulePodLifecycle(pod) {
        if (!pod || pod.lifecycleScheduled || pod.phase !== POD_PHASE.STARTING) return;
        pod.lifecycleScheduled = true;
        const pullDelay = 100 + this.state.faults.imagePullDelayMs;
        this._timer('cloud.kubelet.image-pulled', pullDelay, () => {
            const current = this.state.resources.pods.find((candidate) => candidate.id === pod.id);
            if (!current || current.phase !== POD_PHASE.STARTING) return { progressed: false };
            current.phase = POD_PHASE.RUNNING;
            const readinessDelay = 200 + this.state.faults.readinessDelayMs;
            this._timer('cloud.kubelet.pod-ready', readinessDelay, () => {
                const latest = this.state.resources.pods.find((candidate) => candidate.id === pod.id);
                const node = latest?.nodeId ? byId(this.state.resources.nodes, latest.nodeId) : null;
                if (!latest || latest.phase !== POD_PHASE.RUNNING || !node?.ready) return { progressed: false };
                latest.phase = POD_PHASE.READY;
                latest.ready = true;
                latest.readyAtMs = this.clock.now();
                return { progressed: true, podId: latest.id, phase: latest.phase };
            }, { podId: pod.id });
            return { progressed: true, podId: current.id, phase: current.phase };
        }, { podId: pod.id });
    }

    _rollOut(action) {
        const deployment = getDeployment(this.state);
        recomputeObserved(this.state);
        deployment.rollout = {
            active: true,
            fromVersion: deployment.desired.version,
            toVersion: action.version || 'v42',
            startedReady: deployment.observed.ready,
            oldPodsTerminated: 0,
        };
        deployment.desired.version = deployment.rollout.toVersion;
        this.state.operations.rollout = true;
        return { from: deployment.rollout.fromVersion, to: deployment.rollout.toVersion };
    }

    _rollBack(action) {
        const deployment = getDeployment(this.state);
        const target = action.version || deployment.rollout.fromVersion || 'v41';
        deployment.rollout = {
            active: true,
            fromVersion: deployment.desired.version,
            toVersion: target,
            startedReady: deployment.observed.ready,
            oldPodsTerminated: 0,
        };
        deployment.desired.version = target;
        this.state.operations.rollout = true;
        return { to: target };
    }

    _drain(action) {
        const nodeId = action.nodeId?.startsWith('node/') ? action.nodeId : `node/${action.nodeId || 'node-b'}`;
        const node = byId(this.state.resources.nodes, nodeId);
        if (!node) return { drained: false, reason: 'unknown-node', nodeId };
        node.draining = true;
        if (!this.state.operations.drainNodes.includes(node.id)) this.state.operations.drainNodes.push(node.id);
        const pods = this.state.resources.pods.filter((pod) => pod.nodeId === node.id && isActivePod(pod))
            .sort((left, right) => left.id.localeCompare(right.id));
        const decisions = [];
        for (const pod of pods) {
            const decision = voluntaryDisruptionAllowed(this.state, pod);
            const allowed = action.bypassPdb || decision.allowed;
            const record = {
                actionId: action.id,
                nodeId,
                podId: pod.id,
                voluntary: true,
                allowed,
                availableAfter: decision.availableAfter,
            };
            this.state.history.disruptions.push(record);
            decisions.push(record);
            if (!allowed) continue;
            terminatePod(this.state, pod, 'node-drain');
            this._scheduleTermination(pod);
            recomputeObserved(this.state);
        }
        return { drained: true, nodeId, decisions };
    }

    _crashNode(action) {
        const nodeId = action.nodeId?.startsWith('node/') ? action.nodeId : `node/${action.nodeId || 'node-a'}`;
        const node = byId(this.state.resources.nodes, nodeId);
        if (!node) return { crashed: false, reason: 'unknown-node', nodeId };
        node.ready = false;
        if (!this.state.operations.crashedNodes.includes(node.id)) this.state.operations.crashedNodes.push(node.id);
        const failed = [];
        for (const pod of this.state.resources.pods.filter((candidate) => candidate.nodeId === node.id && isActivePod(candidate))) {
            pod.phase = POD_PHASE.FAILED;
            pod.ready = false;
            failed.push(pod.id);
        }
        const failedSet = new Set(failed);
        for (const service of this.state.resources.services) {
            service.observed.endpointPodIds = service.observed.endpointPodIds.filter((podId) => !failedSet.has(podId));
        }
        return { crashed: true, nodeId, failedPods: failed };
    }

    _recoverNode(action) {
        const nodeId = action.nodeId?.startsWith('node/') ? action.nodeId : `node/${action.nodeId || 'node-a'}`;
        const node = byId(this.state.resources.nodes, nodeId);
        if (!node) return { recovered: false, reason: 'unknown-node', nodeId };
        node.ready = true;
        node.draining = false;
        this.state.operations.crashedNodes = this.state.operations.crashedNodes.filter((id) => id !== node.id);
        this.state.operations.drainNodes = this.state.operations.drainNodes.filter((id) => id !== node.id);
        return { recovered: true, nodeId };
    }

    _degradeZone(action) {
        const zoneId = action.zoneId?.startsWith('zone/') ? action.zoneId : `zone/${action.zoneId || 'zone-a'}`;
        const zone = byId(this.state.resources.zones, zoneId);
        if (!zone) return { degraded: false, reason: 'unknown-zone', zoneId };
        zone.degraded = true;
        const failed = [];
        for (const node of this.state.resources.nodes.filter((candidate) => candidate.zoneId === zoneId)) {
            node.ready = false;
            for (const pod of this.state.resources.pods.filter((candidate) => candidate.nodeId === node.id && isActivePod(candidate))) {
                pod.phase = POD_PHASE.FAILED;
                pod.ready = false;
                failed.push(pod.id);
            }
        }
        const failedSet = new Set(failed);
        getService(this.state).observed.endpointPodIds = getService(this.state).observed.endpointPodIds
            .filter((podId) => !failedSet.has(podId));
        return { degraded: true, zoneId, failedPods: failed };
    }

    async execute(action) {
        if (action.type === CLOUD_ACTION.ADVANCE_TIME) {
            const before = canonicalState(this.state);
            const requestedAtMs = this.clock.now();
            await this.clock.runFor(Math.max(0, action.ms || 0));
            this.state.clockMs = this.clock.now();
            recomputeObserved(this.state);
            const evaluated = this.telemetry.capture(before, action, canonicalState(this.state), {
                source: 'schedule', requestedAtMs, outcome: { advancedMs: action.ms || 0 },
            });
            if (!this.firstFailure && evaluated.failure) this.firstFailure = clone(evaluated.failure);
            this.trace.push({ sequence: ++this.sequence, atMs: this.state.clockMs, action: clone(action),
                outcome: { advancedMs: action.ms || 0 }, failure: clone(evaluated.failure) });
            return;
        }

        this._transition(action, () => {
            switch (action.type) {
                case CLOUD_ACTION.ROLL_OUT: return this._rollOut(action);
                case CLOUD_ACTION.ROLL_BACK: return this._rollBack(action);
                case CLOUD_ACTION.SCALE: {
                    const deployment = getDeployment(this.state);
                    const from = deployment.desired.replicas;
                    deployment.desired.replicas = Math.max(0, Number(action.replicas));
                    return { from, to: deployment.desired.replicas };
                }
                case CLOUD_ACTION.DRAIN_NODE:
                case CLOUD_FAULT.NODE_DRAIN: return this._drain(action);
                case CLOUD_ACTION.RECOVER_NODE: return this._recoverNode(action);
                case CLOUD_ACTION.TRAFFIC_SPIKE: {
                    this.state.traffic.cpuPercent = action.cpuPercent || 91;
                    this.state.traffic.requestsPerSecond = action.requestsPerSecond || 480;
                    this.state.traffic.latencyMs = action.latencyMs || 126;
                    return clone(this.state.traffic);
                }
                case CLOUD_FAULT.NODE_CRASH: return this._crashNode(action);
                case CLOUD_FAULT.ZONE_DEGRADED: return this._degradeZone(action);
                case CLOUD_FAULT.READINESS_DELAY:
                    this.state.faults.readinessDelayMs = Math.max(0, action.delayMs || 900);
                    return { delayMs: this.state.faults.readinessDelayMs };
                case CLOUD_FAULT.IMAGE_PULL_DELAY:
                    this.state.faults.imagePullDelayMs = Math.max(0, action.delayMs || 700);
                    return { delayMs: this.state.faults.imagePullDelayMs };
                case CLOUD_FAULT.HPA_STALE_METRIC: {
                    const hpa = getHpa(this.state);
                    this.state.faults.staleMetricValue = action.metric ?? hpa.observed.currentMetric;
                    this.state.faults.staleMetricUntilMs = this.state.clockMs + (action.durationMs || 500);
                    return { metric: this.state.faults.staleMetricValue,
                        untilMs: this.state.faults.staleMetricUntilMs };
                }
                case CLOUD_FAULT.ENDPOINT_PROPAGATION_DELAY:
                    this.state.faults.endpointPropagationDelayMs = Math.max(0, action.delayMs || 800);
                    return { delayMs: this.state.faults.endpointPropagationDelayMs };
                case CLOUD_FAULT.CONTROLLER_RESTART: {
                    const name = action.controller || 'deployment';
                    if (!this.state.controllers[name]) return { restarted: false, reason: 'unknown-controller' };
                    this.state.controllers[name].restartUntilMs = this.state.clockMs + (action.durationMs || 500);
                    return { restarted: true, controller: name,
                        untilMs: this.state.controllers[name].restartUntilMs };
                }
                case CONTROLLER_ACTION.DEPLOYMENT: {
                    const result = reconcileDeployment(this.state, this.mutant.flags);
                    if (result.terminated) this._scheduleTermination(
                        this.state.resources.pods.find((pod) => pod.id === result.terminated),
                    );
                    return result;
                }
                case CONTROLLER_ACTION.SCHEDULER: {
                    const result = scheduleOne(this.state);
                    if (result.scheduled) this._schedulePodLifecycle(
                        this.state.resources.pods.find((pod) => pod.id === result.podId),
                    );
                    return result;
                }
                case CONTROLLER_ACTION.KUBELET: {
                    const pods = this.state.resources.pods.filter((pod) => pod.phase === POD_PHASE.STARTING);
                    pods.forEach((pod) => this._schedulePodLifecycle(pod));
                    return { watchedPods: pods.map((pod) => pod.id) };
                }
                case CONTROLLER_ACTION.ENDPOINTS: {
                    const result = reconcileEndpoints(this.state, this.mutant.flags);
                    if (result.endpointPodIds) {
                        this._timer('cloud.controller.endpoints-propagated',
                            this.state.faults.endpointPropagationDelayMs,
                            () => ({ endpointPodIds: applyEndpointSnapshot(this.state, result.endpointPodIds) }));
                    }
                    return result;
                }
                case CONTROLLER_ACTION.HPA: return reconcileHpa(this.state, this.mutant.flags);
                case CONTROLLER_ACTION.PDB: return { disruptionsAllowed: this.state.resources.pdbs[0]
                    .observed.disruptionsAllowed };
                case CONTROLLER_ACTION.YIELD: return { yielded: true, label: action.label || null };
                default: return { ignored: true };
            }
        }, { source: 'schedule' });
    }

    export() {
        return canonicalState(this.state);
    }
}

async function runCloudSchedule(input, options = {}) {
    validateCloudSchedule(input);
    const schedule = cloneAction(input);
    const simulation = new CloudRuntimeSimulation({
        seed: schedule.seed,
        mutant: options.mutant || schedule.runtime || 'correct',
        topology: schedule.topology?.maxUnavailable === undefined ? null : schedule.topology,
        traffic: schedule.scenarioParameters?.traffic || null,
        horizonTransitions: options.horizonTransitions
            ?? (schedule.strategy === 'research-corpus' ? 5 : null),
    });
    for (const action of schedule.actions) await simulation.execute(action);
    const finalState = simulation.export();
    const evaluated = evaluateCloudInvariants(finalState);
    const failure = simulation.firstFailure || evaluated.failure;
    const dataset = simulation.telemetry.export();
    const trace = { schemaVersion: 1, kind: 'cloudproof.transition-trace', transitions: clone(simulation.trace) };
    const replayFingerprint = digest({ failure: failure?.fingerprint || null, finalState, trace, dataset });
    return {
        ok: failure === null,
        failure,
        checks: evaluated.checks,
        schedule,
        trace,
        graphTransitions: dataset,
        finalState,
        replayFingerprint,
        mutant: simulation.mutant.id,
        metrics: {
            actions: schedule.actions.length,
            transitions: dataset.length,
            minReadyReplicas: dataset.reduce((minimum, row) => (
                Math.min(minimum, row.labels.minReadyReplicas)
            ), getService(finalState).observed.endpointPodIds.length),
        },
    };
}

module.exports = { CloudRuntimeSimulation, runCloudSchedule };
