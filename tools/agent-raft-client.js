'use strict';

/**
 * Small reference client for the Raft-backed agent API. The provider methods
 * are intentionally unreachable until the corresponding intent/dispatch
 * command has returned `committed: true` from a majority.
 */

class AgentCommandError extends Error {
    constructor(message, { status = 0, body = null } = {}) {
        super(message);
        this.name = 'AgentCommandError';
        this.status = status;
        this.body = body;
    }
}

async function requestJson(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            ...options,
            redirect: 'manual',
            signal: controller.signal,
        });
        const text = await response.text();
        let body = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch (_) {
            body = { raw: text };
        }
        return { status: response.status, ok: response.ok, body };
    } finally {
        clearTimeout(timer);
    }
}

class RaftAgentClient {
    constructor({ replicaUrls, providerUrl, clientId = 'agent-worker' }) {
        this.replicaUrls = replicaUrls;
        this.providerUrl = providerUrl;
        this.clientId = clientId;
        this.seqNo = 0;
    }

    async statuses() {
        return Promise.all(this.replicaUrls.map(async (url) => {
            try {
                const response = await requestJson(`${url}/status`, {}, 1200);
                return response.ok ? { url, ...response.body } : null;
            } catch (_) {
                return null;
            }
        }));
    }

    async leader() {
        const statuses = await this.statuses();
        const leader = statuses.find((status) => status && status.state === 'LEADER');
        if (!leader) throw new AgentCommandError('no Raft leader is reachable');
        return leader;
    }

    next(command) {
        this.seqNo += 1;
        return { ...command, clientId: this.clientId, seqNo: this.seqNo };
    }

    async command(command, { retries = 8 } = {}) {
        const durableCommand = command.clientId ? command : this.next(command);
        let lastError = null;
        for (let attempt = 0; attempt < retries; attempt += 1) {
            try {
                const leader = await this.leader();
                const response = await requestJson(`${leader.url}/agent/commands`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(durableCommand),
                }, 5000);
                if (response.status === 307) continue;
                if (!response.ok) {
                    throw new AgentCommandError(
                        response.body?.error || `agent command failed with ${response.status}`,
                        response,
                    );
                }
                if (response.body?.committed !== true) {
                    throw new AgentCommandError('command was not acknowledged as committed', response);
                }
                return response.body;
            } catch (error) {
                lastError = error;
                if (error instanceof AgentCommandError && [409, 503].includes(error.status)) throw error;
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        }
        throw lastError || new AgentCommandError('agent command failed');
    }

    async execution(executionId, { url = null, stale = false } = {}) {
        const target = url || (await this.leader()).url;
        const suffix = stale ? '?stale=1' : '';
        const response = await requestJson(
            `${target}/agent/executions/${encodeURIComponent(executionId)}${suffix}`,
            {},
            3000,
        );
        if (!response.ok) {
            throw new AgentCommandError(response.body?.error || 'execution read failed', response);
        }
        return response.body.execution;
    }

    async resource(resourceId, { url = null, stale = false } = {}) {
        const target = url || (await this.leader()).url;
        const suffix = stale ? '?stale=1' : '';
        const response = await requestJson(
            `${target}/agent/resources/${encodeURIComponent(resourceId)}${suffix}`,
            {},
            3000,
        );
        if (!response.ok) {
            throw new AgentCommandError(response.body?.error || 'resource read failed', response);
        }
        return response.body.resource;
    }

    async providerState() {
        const response = await requestJson(`${this.providerUrl}/state`);
        if (!response.ok) throw new AgentCommandError('provider state read failed', response);
        return response.body;
    }

    async providerLookup(effectId) {
        const response = await requestJson(
            `${this.providerUrl}/refund/${encodeURIComponent(effectId)}`,
        );
        if (response.status === 404) return null;
        if (!response.ok) throw new AgentCommandError('provider lookup failed', response);
        return response.body.refund;
    }

    async providerRefund(parameters, { dropResponse = false } = {}) {
        const response = await requestJson(`${this.providerUrl}/refund`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(dropResponse ? { 'x-drop-response': '1' } : {}),
            },
            body: JSON.stringify(parameters),
        });
        if (!response.ok) throw new AgentCommandError('provider refund failed', response);
        return response.body.refund;
    }

    async createExecution({ executionId, workflow, snapshot, initialState = {} }) {
        return this.command({
            op: 'agent.execution.create', executionId, workflow, snapshot, initialState,
        });
    }

    async createResource({ resourceId, version = 1, state = {} }) {
        return this.command({ op: 'agent.resource.create', resourceId, version, state });
    }

    async recordResourcePlan({ executionId, readSet, writeSet }) {
        return this.command({ op: 'agent.execution.plan', executionId, readSet, writeSet });
    }

    async authorizeResourceEffect({
        executionId, effectId, logicalAction, parameters = {}, snapshotId,
    }) {
        return this.command({
            op: 'agent.effect.authorize-resource',
            executionId,
            effectId,
            logicalAction,
            parameters,
            snapshotId,
        });
    }

    async recordIntent({ executionId, effectId, logicalAction, parameters, snapshotId }) {
        return this.command({
            op: 'agent.effect.intent', executionId, effectId,
            logicalAction, parameters, snapshotId,
        });
    }

    async authorizeDispatch(executionId, effectId) {
        return this.command({ op: 'agent.effect.dispatch', executionId, effectId });
    }

    async recordResult(executionId, effectId, result) {
        return this.command({ op: 'agent.effect.result', executionId, effectId, result });
    }

    async commitEffect(executionId, effectId) {
        return this.command({ op: 'agent.effect.commit', executionId, effectId });
    }

    async startRefund({ executionId, effectId, parameters, snapshotId, dropResponse = false }) {
        await this.recordIntent({
            executionId, effectId, logicalAction: 'refund-payment', parameters, snapshotId,
        });
        // This second committed transition counts/authorizes an actual remote
        // attempt. A provider call is never issued if either commit fails.
        await this.authorizeDispatch(executionId, effectId);
        const refund = await this.providerRefund({ effectId, ...parameters }, { dropResponse });
        await this.recordResult(executionId, effectId, refund);
        await this.commitEffect(executionId, effectId);
        return refund;
    }

    async resumeRefund(executionId, effectId) {
        const execution = await this.execution(executionId);
        const effect = execution.effects.find((candidate) => candidate.effectId === effectId);
        if (!effect) return { action: 'execute-new', result: null };
        if (effect.status === 'EFFECT_COMMITTED') {
            return { action: 'return-recorded-result', result: effect.result };
        }
        if (effect.status === 'RESULT_RECORDED') {
            await this.commitEffect(executionId, effectId);
            return { action: 'commit-recorded-result', result: effect.result };
        }

        await this.command({
            op: 'agent.effect.reconciliation-required', executionId, effectId,
        });
        const refund = await this.providerLookup(effectId);
        if (refund) {
            await this.recordResult(executionId, effectId, refund);
            await this.commitEffect(executionId, effectId);
            return { action: 'reconciled-provider-result', result: refund };
        }

        await this.authorizeDispatch(executionId, effectId);
        const parameters = effect.parameters;
        const created = await this.providerRefund({ effectId, ...parameters });
        await this.recordResult(executionId, effectId, created);
        await this.commitEffect(executionId, effectId);
        return { action: 'executed-after-not-found', result: created };
    }
}

module.exports = { AgentCommandError, RaftAgentClient, requestJson };
