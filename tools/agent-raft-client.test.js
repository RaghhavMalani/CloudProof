'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { AgentCommandError, RaftAgentClient } = require('./agent-raft-client');

function respond(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

async function listen(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        server,
        url: `http://127.0.0.1:${server.address().port}`,
    };
}

test('provider call is impossible when dispatch authorization misses quorum', async (t) => {
    let commandCount = 0;
    let providerCalls = 0;
    const raft = await listen((req, res) => {
        if (req.url === '/status') return respond(res, 200, { state: 'LEADER', replicaId: 'r1' });
        if (req.url === '/agent/commands') {
            commandCount += 1;
            return commandCount === 1
                ? respond(res, 200, { ok: true, committed: true, index: 4 })
                : respond(res, 503, { error: 'quorum unavailable', retryable: true });
        }
        return respond(res, 404, {});
    });
    const provider = await listen((req, res) => {
        if (req.method === 'POST' && req.url === '/refund') providerCalls += 1;
        return respond(res, 200, { refund: { providerRefundId: 'unexpected' } });
    });
    t.after(() => { raft.server.close(); provider.server.close(); });

    const client = new RaftAgentClient({
        replicaUrls: [raft.url], providerUrl: provider.url, clientId: 'quorum-test',
    });
    await assert.rejects(
        client.startRefund({
            executionId: 'e1', effectId: 'fx1', snapshotId: 's1',
            parameters: { orderId: 1, amountCents: 899900 },
        }),
        (error) => error instanceof AgentCommandError && error.status === 503,
    );
    assert.equal(commandCount, 2, 'intent committed, dispatch authorization did not');
    assert.equal(providerCalls, 0, 'no external mutation follows an uncommitted authorization');
});

test('recorded results finish locally without any provider request', async (t) => {
    let providerCalls = 0;
    const raft = await listen((req, res) => {
        if (req.url === '/status') return respond(res, 200, { state: 'LEADER', replicaId: 'r1' });
        if (req.method === 'GET' && req.url.startsWith('/agent/executions/e1')) {
            return respond(res, 200, {
                execution: {
                    executionId: 'e1',
                    effects: [{
                        effectId: 'fx1', status: 'RESULT_RECORDED', attempts: 1,
                        parameters: { orderId: 1, amountCents: 899900 },
                        result: { providerRefundId: 'rf_1' },
                    }],
                },
            });
        }
        if (req.method === 'POST' && req.url === '/agent/commands') {
            return respond(res, 200, { ok: true, committed: true, index: 8 });
        }
        return respond(res, 404, {});
    });
    const provider = await listen((req, res) => {
        providerCalls += 1;
        return respond(res, 500, { error: 'must not be called' });
    });
    t.after(() => { raft.server.close(); provider.server.close(); });

    const client = new RaftAgentClient({
        replicaUrls: [raft.url], providerUrl: provider.url, clientId: 'resume-test',
    });
    const outcome = await client.resumeRefund('e1', 'fx1');
    assert.equal(outcome.action, 'commit-recorded-result');
    assert.equal(outcome.result.providerRefundId, 'rf_1');
    assert.equal(providerCalls, 0);
});
