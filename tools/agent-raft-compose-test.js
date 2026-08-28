'use strict';

/**
 * Real three-node Stage 4 acceptance campaign.
 *
 * It stops actual Compose services at each external-effect boundary, creates a
 * provider-success/response-loss ambiguity, verifies failover behavior, then
 * performs a full `down`/`up` cycle without deleting volumes and verifies
 * byte-equivalent logical state on all replicas.
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { makeEffectId } = require('../packages/agent-runtime');
const { RaftAgentClient, AgentCommandError, requestJson } = require('./agent-raft-client');

const PROJECT = process.env.AGENT_RAFT_COMPOSE_PROJECT || 'miniraft-agent-stage4-test';
const REPLICA_URLS = ['http://127.0.0.1:15001', 'http://127.0.0.1:15002', 'http://127.0.0.1:15003'];
const PROVIDER_URL = 'http://127.0.0.1:16000';
const COMPOSE_ENV = {
    ...process.env,
    REPLICA1_HOST_PORT: '15001',
    REPLICA2_HOST_PORT: '15002',
    REPLICA3_HOST_PORT: '15003',
    GATEWAY_HOST_PORT: '14000',
    REFUND_PROVIDER_HOST_PORT: '16000',
};
const SNAPSHOT_V4 = {
    id: 'snapshot:refund-policy-v4',
    resources: {
        workflow: 'refund-agent-v7',
        model: 'model-2026-08-20',
        prompt: 'sha256:a892',
        policy: 'refund-policy-v4',
        retrievalIndex: 'support-index-v81',
        toolSchemas: { payments: 'v2', orders: 'v14', crm: 'v6', mail: 'v3' },
    },
};
const SNAPSHOT_V5 = {
    ...SNAPSHOT_V4,
    id: 'snapshot:refund-policy-v5',
    resources: { ...SNAPSHOT_V4.resources, policy: 'refund-policy-v5' },
};

function log(message) {
    process.stdout.write(`[agent-raft-live] ${message}\n`);
}

function compose(args, { capture = false, allowFailure = false } = {}) {
    const outcome = spawnSync('docker', ['compose', '-p', PROJECT, ...args], {
        env: COMPOSE_ENV,
        encoding: 'utf8',
        stdio: capture ? 'pipe' : 'inherit',
    });
    if (outcome.error) throw outcome.error;
    if (outcome.status !== 0 && !allowFailure) {
        throw new Error(`docker compose ${args.join(' ')} failed (${outcome.status})\n${outcome.stderr || ''}`);
    }
    return outcome;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(label, probe, { timeoutMs = 45000, intervalMs = 300 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const value = await probe();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await sleep(intervalMs);
    }
    throw new Error(`${label} did not become true within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForCluster(client, expectedReachable = 3) {
    return eventually(`${expectedReachable} replicas and a leader`, async () => {
        const statuses = (await client.statuses()).filter(Boolean);
        const leaders = statuses.filter((status) => status.state === 'LEADER');
        return statuses.length === expectedReachable && leaders.length === 1 ? leaders[0] : null;
    });
}

async function stopLeader(client) {
    const before = await client.leader();
    log(`stopping leader ${before.replicaId} at term ${before.term}`);
    compose(['stop', before.replicaId]);
    const after = await eventually('replacement leader', async () => {
        const statuses = (await client.statuses()).filter(Boolean);
        return statuses.find(
            (status) => status.state === 'LEADER' && status.replicaId !== before.replicaId,
        ) || null;
    });
    return { stopped: before.replicaId, leader: after };
}

async function restoreReplica(client, service, executionId = null) {
    compose(['start', service]);
    await waitForCluster(client, 3);
    if (executionId) await waitForConvergence(client, executionId);
}

async function waitForConvergence(client, executionId) {
    return eventually(`execution ${executionId} convergence`, async () => {
        const reads = await Promise.all(REPLICA_URLS.map(async (url) => {
            try {
                return await client.execution(executionId, { url, stale: true });
            } catch (_) {
                return null;
            }
        }));
        if (reads.some((execution) => !execution)) return null;
        const encoded = reads.map((execution) => JSON.stringify(execution));
        return new Set(encoded).size === 1 ? reads[0] : null;
    });
}

function refundSpec(suffix) {
    const executionId = `refund-${suffix}`;
    const parameters = { orderId: `order-${suffix}`, amountCents: 899900, currency: 'INR' };
    return {
        executionId,
        effectId: makeEffectId(executionId, 'refund-payment', parameters),
        parameters,
    };
}

async function create(client, spec) {
    await client.createExecution({
        executionId: spec.executionId,
        workflow: 'refund-agent-v7',
        snapshot: SNAPSHOT_V4,
        initialState: { crmUpdates: 0, emails: 0 },
    });
}

async function intent(client, spec) {
    return client.recordIntent({
        ...spec,
        logicalAction: 'refund-payment',
        snapshotId: SNAPSHOT_V4.id,
    });
}

async function boundaryA(client) {
    log('boundary A: uncommitted intent cannot authorize a provider call');
    const spec = refundSpec('boundary-a');
    await create(client, spec);
    const providerBefore = await client.providerState();
    const leader = await client.leader();
    const followers = ['replica1', 'replica2', 'replica3'].filter((id) => id !== leader.replicaId);
    compose(['stop', ...followers]);

    const durableCommand = {
        op: 'agent.effect.intent', executionId: spec.executionId, effectId: spec.effectId,
        logicalAction: 'refund-payment', parameters: spec.parameters, snapshotId: SNAPSHOT_V4.id,
        clientId: 'boundary-a-isolated-worker', seqNo: 1,
    };
    const response = await requestJson(`${leader.url}/agent/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(durableCommand),
    }, 6000);
    assert.equal(response.status, 503, 'isolated leader must not claim intent committed');
    assert.equal(response.body.retryable, true);
    assert.deepEqual(await client.providerState(), providerBefore, 'provider was never contacted');

    compose(['stop', leader.replicaId]);
    compose(['start', ...followers]);
    await waitForCluster(client, 2);
    const surviving = await client.execution(spec.executionId);
    assert.equal(surviving.effects.length, 0, 'uncommitted intent is absent from the new leader');
    await restoreReplica(client, leader.replicaId, spec.executionId);
}

async function boundaryB(client) {
    log('boundary B: committed intent, crash before call, reconcile-not-found then execute');
    const spec = refundSpec('boundary-b');
    await create(client, spec);
    await intent(client, spec);
    const { stopped } = await stopLeader(client);
    const outcome = await client.resumeRefund(spec.executionId, spec.effectId);
    assert.equal(outcome.action, 'executed-after-not-found');
    const execution = await client.execution(spec.executionId);
    assert.equal(execution.effects[0].status, 'EFFECT_COMMITTED');
    assert.equal(execution.effects[0].attempts, 1);
    await restoreReplica(client, stopped, spec.executionId);
}

async function boundaryC(client) {
    log('boundary C: provider succeeds, response disappears, leader dies, next leader reconciles');
    const spec = refundSpec('flagship-c');
    const providerBefore = await client.providerState();
    await create(client, spec);

    const racer = new RaftAgentClient({
        replicaUrls: REPLICA_URLS, providerUrl: PROVIDER_URL, clientId: 'racing-worker',
    });
    const advances = await Promise.allSettled([
        client.command({
            op: 'agent.execution.advance', executionId: spec.executionId,
            expectedStep: 0, label: 'policy-authorized-a', patch: { authorized: true },
        }),
        racer.command({
            op: 'agent.execution.advance', executionId: spec.executionId,
            expectedStep: 0, label: 'policy-authorized-b', patch: { authorized: true },
        }),
    ]);
    assert.equal(advances.filter((item) => item.status === 'fulfilled').length, 1);
    const rejected = advances.find((item) => item.status === 'rejected').reason;
    assert.ok(rejected instanceof AgentCommandError);
    assert.equal(rejected.body.error, 'STALE_EXECUTION_VERSION');

    await intent(client, spec);
    await client.authorizeDispatch(spec.executionId, spec.effectId);
    await assert.rejects(client.providerRefund(
        { effectId: spec.effectId, ...spec.parameters },
        { dropResponse: true },
    ));
    const providerAfterLoss = await client.providerState();
    assert.ok(providerAfterLoss.refunds[spec.effectId], 'provider committed before dropping the socket');
    assert.equal(providerAfterLoss.refundCount, providerBefore.refundCount + 1);
    assert.equal(providerAfterLoss.requestCount, providerBefore.requestCount + 1);

    let failover = await stopLeader(client);
    const resolution = await client.resumeRefund(spec.executionId, spec.effectId);
    assert.equal(resolution.action, 'reconciled-provider-result');
    const providerAfterReconcile = await client.providerState();
    assert.equal(providerAfterReconcile.refunds[spec.effectId].status, 'SUCCEEDED');
    assert.equal(providerAfterReconcile.refundCount, providerAfterLoss.refundCount);
    assert.equal(providerAfterReconcile.requestCount, providerAfterLoss.requestCount);
    assert.equal(providerAfterReconcile.lookupCount, providerAfterLoss.lookupCount + 1);
    await restoreReplica(client, failover.stopped, spec.executionId);

    // A consensus-recorded semantic pause must survive another leader death.
    await client.command({
        op: 'agent.semantic-conflict.detect', executionId: spec.executionId,
        availableSnapshot: SNAPSHOT_V5, changed: ['policy'], decision: 'require-approval',
    });
    failover = await stopLeader(client);
    let execution = await client.execution(spec.executionId);
    assert.equal(execution.status, 'PAUSED_SEMANTIC_CONFLICT');
    assert.equal(execution.semanticConflict.availableSnapshot.id, SNAPSHOT_V5.id);
    await client.command({
        op: 'agent.snapshot.transition', executionId: spec.executionId,
        fromSnapshotId: SNAPSHOT_V4.id, toSnapshot: SNAPSHOT_V5,
        approval: { approved: true, approvedBy: 'stage4-test-operator' },
    });
    await restoreReplica(client, failover.stopped, spec.executionId);

    execution = await client.execution(spec.executionId);
    await client.command({
        op: 'agent.execution.advance', executionId: spec.executionId,
        expectedStep: execution.step, label: 'crm-updated', patch: { crmUpdates: 1 },
    });
    execution = await client.execution(spec.executionId);
    await client.command({
        op: 'agent.execution.advance', executionId: spec.executionId,
        expectedStep: execution.step, label: 'email-sent', patch: { emails: 1 },
    });
    execution = await client.execution(spec.executionId);
    await client.command({
        op: 'agent.execution.complete', executionId: spec.executionId,
        expectedStep: execution.step,
    });
    return spec;
}

async function boundaryD(client) {
    log('boundary D: recorded provider result commits after failover without provider activity');
    const spec = refundSpec('boundary-d');
    await create(client, spec);
    await intent(client, spec);
    await client.authorizeDispatch(spec.executionId, spec.effectId);
    const refund = await client.providerRefund({ effectId: spec.effectId, ...spec.parameters });
    await client.recordResult(spec.executionId, spec.effectId, refund);
    const providerBefore = await client.providerState();
    const { stopped } = await stopLeader(client);
    const outcome = await client.resumeRefund(spec.executionId, spec.effectId);
    assert.equal(outcome.action, 'commit-recorded-result');
    assert.deepEqual(await client.providerState(), providerBefore);
    await restoreReplica(client, stopped, spec.executionId);
}

async function boundaryE(client) {
    log('boundary E: committed effect returns its result with zero external activity');
    const spec = refundSpec('boundary-e');
    await create(client, spec);
    await client.startRefund({ ...spec, snapshotId: SNAPSHOT_V4.id });
    const providerBefore = await client.providerState();
    const { stopped } = await stopLeader(client);
    const outcome = await client.resumeRefund(spec.executionId, spec.effectId);
    assert.equal(outcome.action, 'return-recorded-result');
    assert.deepEqual(await client.providerState(), providerBefore);
    await restoreReplica(client, stopped, spec.executionId);
}

async function campaign() {
    const client = new RaftAgentClient({
        replicaUrls: REPLICA_URLS,
        providerUrl: PROVIDER_URL,
        clientId: 'stage4-primary-worker',
    });
    let failed = false;
    try {
        compose(['version'], { capture: true });
        compose(['down', '--volumes', '--remove-orphans'], { allowFailure: true });
        compose(['up', '--build', '--detach', 'replica1', 'replica2', 'replica3', 'refund-provider']);
        await eventually('provider health', async () => {
            try { return (await requestJson(`${PROVIDER_URL}/health`, {}, 1000)).ok; } catch (_) { return false; }
        });
        await waitForCluster(client);

        await boundaryA(client);
        await boundaryB(client);
        const flagship = await boundaryC(client);
        await boundaryD(client);
        await boundaryE(client);

        const beforeRestart = await waitForConvergence(client, flagship.executionId);
        assert.equal(beforeRestart.effects.length, 1);
        assert.equal(beforeRestart.effects[0].status, 'EFFECT_COMMITTED');
        assert.ok(beforeRestart.effects[0].attempts >= 1);
        assert.equal(beforeRestart.state.crmUpdates, 1);
        assert.equal(beforeRestart.state.emails, 1);
        assert.equal(beforeRestart.status, 'COMPLETE');
        assert.equal(beforeRestart.snapshot.id, SNAPSHOT_V5.id);
        const providerBeforeRestart = await client.providerState();
        assert.ok(providerBeforeRestart.refunds[flagship.effectId]);

        log('full cluster down/up: rebuilding execution exclusively from durable logs');
        compose(['down', '--remove-orphans']);
        compose(['up', '--detach', 'replica1', 'replica2', 'replica3', 'refund-provider']);
        await eventually('provider health after restart', async () => {
            try { return (await requestJson(`${PROVIDER_URL}/health`, {}, 1000)).ok; } catch (_) { return false; }
        });
        await waitForCluster(client);
        const afterRestart = await waitForConvergence(client, flagship.executionId);
        assert.equal(JSON.stringify(afterRestart), JSON.stringify(beforeRestart));
        assert.deepEqual(await client.providerState(), providerBeforeRestart);

        log('PASS: boundaries A-E, exactly-one flagship refund, fencing, convergence, and restart');
    } catch (error) {
        failed = true;
        process.stderr.write(`${error.stack || error.message}\n`);
        const logs = compose(['logs', '--no-color', '--tail', '200'], {
            capture: true, allowFailure: true,
        });
        process.stderr.write(logs.stdout || logs.stderr || '');
        process.exitCode = 1;
    } finally {
        if (process.env.KEEP_AGENT_RAFT_CLUSTER === '1') {
            log(`leaving Compose project ${PROJECT} running by request`);
        } else {
            compose(['down', '--volumes', '--remove-orphans'], { allowFailure: true });
        }
        if (failed) log('FAIL');
    }
}

if (require.main === module) void campaign();

module.exports = { campaign };
