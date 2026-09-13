'use strict';

const { POD_PHASE } = require('./resources');
const { isActivePod } = require('./state');

function tolerates(taint, tolerations = []) {
    return tolerations.some((candidate) => (
        candidate.key === taint.key
        && (candidate.value === taint.value || candidate.operator === 'Exists')
        && (!candidate.effect || candidate.effect === taint.effect)
    ));
}

function resourceUsage(state, nodeId) {
    return state.resources.pods
        .filter((pod) => pod.nodeId === nodeId && isActivePod(pod))
        .reduce((usage, pod) => ({
            cpuMillicores: usage.cpuMillicores + pod.requests.cpuMillicores,
            memoryMb: usage.memoryMb + pod.requests.memoryMb,
            pods: usage.pods + 1,
        }), { cpuMillicores: 0, memoryMb: 0, pods: 0 });
}

function feasibleNodes(state, pod) {
    return state.resources.nodes.filter((node) => {
        if (!node.ready || node.draining) return false;
        if (node.taints.some((taint) => taint.effect === 'NoSchedule'
            && !tolerates(taint, pod.tolerations))) return false;
        const usage = resourceUsage(state, node.id);
        return usage.cpuMillicores + pod.requests.cpuMillicores <= node.capacity.cpuMillicores
            && usage.memoryMb + pod.requests.memoryMb <= node.capacity.memoryMb;
    });
}

function chooseNode(state, pod) {
    const candidates = feasibleNodes(state, pod).map((node) => {
        const usage = resourceUsage(state, node.id);
        const zonePods = state.resources.pods.filter((candidate) => {
            if (!candidate.nodeId || !isActivePod(candidate)) return false;
            const candidateNode = state.resources.nodes.find((item) => item.id === candidate.nodeId);
            return candidateNode?.zoneId === node.zoneId;
        }).length;
        return { node, usage, zonePods };
    });
    candidates.sort((left, right) => (
        left.zonePods - right.zonePods
        || left.usage.pods - right.usage.pods
        || left.usage.cpuMillicores - right.usage.cpuMillicores
        || left.node.id.localeCompare(right.node.id)
    ));
    return candidates[0]?.node || null;
}

function scheduleOne(state) {
    const pending = state.resources.pods
        .filter((pod) => pod.phase === POD_PHASE.PENDING && !pod.nodeId)
        .sort((left, right) => left.id.localeCompare(right.id))[0];
    if (!pending) return { scheduled: false, reason: 'no-pending-pods' };
    const target = chooseNode(state, pending);
    if (!target) return { scheduled: false, podId: pending.id, reason: 'no-feasible-node' };
    pending.nodeId = target.id;
    pending.phase = POD_PHASE.STARTING;
    pending.ready = false;
    return { scheduled: true, podId: pending.id, nodeId: target.id };
}

module.exports = { chooseNode, feasibleNodes, resourceUsage, scheduleOne, tolerates };
