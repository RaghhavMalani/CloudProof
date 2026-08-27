'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { RefundStore, createServer } = require('./index');

test('effectId produces one durable provider-side refund across retries and restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-provider-'));
    const filePath = path.join(directory, 'refunds.json');
    try {
        const store = new RefundStore(filePath);
        const request = { effectId: 'effect:4821', orderId: 4821, amountCents: 899900 };
        assert.equal(store.refund(request).duplicate, false);
        assert.equal(store.refund(request).duplicate, true);
        assert.throws(
            () => store.refund({ ...request, amountCents: 1 }),
            /reused with different parameters/,
        );

        const restarted = new RefundStore(filePath);
        assert.equal(restarted.snapshot().refundCount, 1);
        assert.equal(restarted.snapshot().requestCount, 2);
        assert.equal(restarted.lookup(request.effectId).amountCents, 899900);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('dropped response happens after the refund is durably observable', async (t) => {
    const store = new RefundStore(false);
    const server = createServer({ store });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const { port } = server.address();

    await assert.rejects(fetch(`http://127.0.0.1:${port}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-drop-response': '1' },
        body: JSON.stringify({ effectId: 'effect:lost', orderId: 4821, amountCents: 899900 }),
    }));
    assert.equal(store.snapshot().refundCount, 1);
    assert.equal(store.lookup('effect:lost').status, 'SUCCEEDED');
});
