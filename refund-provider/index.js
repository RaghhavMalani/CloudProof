'use strict';

/**
 * A deliberately separate, durable refund provider used by the live failure
 * test. It owns its own disk and accepts the Raft effect ID as an idempotency
 * key. `x-drop-response: 1` closes the socket after persisting the refund,
 * creating a real ambiguous RPC outcome.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

class RefundStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.state = { refunds: {}, requestCount: 0, lookupCount: 0 };
        if (filePath && fs.existsSync(filePath)) {
            this.state = { ...this.state, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
        }
    }

    refund({ effectId, orderId, amountCents, currency = 'INR' }) {
        if (typeof effectId !== 'string' || effectId.length === 0) {
            throw new TypeError('effectId is required');
        }
        if (!Number.isInteger(amountCents) || amountCents <= 0) {
            throw new TypeError('amountCents must be a positive integer');
        }
        this.state.requestCount += 1;
        const existing = this.state.refunds[effectId];
        if (existing) {
            const matches = existing.orderId === orderId
                && existing.amountCents === amountCents
                && existing.currency === currency;
            if (!matches) {
                throw new Error(`effectId ${effectId} was reused with different parameters`);
            }
            this._persist();
            return { refund: existing, duplicate: true };
        }
        const refund = {
            effectId,
            providerRefundId: `rf_${crypto.createHash('sha256').update(effectId).digest('hex').slice(0, 16)}`,
            orderId,
            amountCents,
            currency,
            status: 'SUCCEEDED',
        };
        this.state.refunds[effectId] = refund;
        this._persist();
        return { refund, duplicate: false };
    }

    lookup(effectId) {
        this.state.lookupCount += 1;
        this._persist();
        return this.state.refunds[effectId] || null;
    }

    snapshot() {
        return {
            requestCount: this.state.requestCount,
            lookupCount: this.state.lookupCount,
            refundCount: Object.keys(this.state.refunds).length,
            refunds: Object.fromEntries(Object.entries(this.state.refunds).sort()),
        };
    }

    _persist() {
        if (!this.filePath) return;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify(this.state)}\n`, 'utf8');
        fs.renameSync(temporary, this.filePath);
    }
}

function json(res, status, body) {
    const encoded = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(encoded),
    });
    res.end(encoded);
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 64 * 1024) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function createServer({ store }) {
    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://refund-provider');
            if (req.method === 'GET' && url.pathname === '/health') {
                return json(res, 200, { ok: true });
            }
            if (req.method === 'GET' && url.pathname === '/state') {
                return json(res, 200, store.snapshot());
            }
            if (req.method === 'GET' && url.pathname.startsWith('/refund/')) {
                const effectId = decodeURIComponent(url.pathname.slice('/refund/'.length));
                const refund = store.lookup(effectId);
                return refund
                    ? json(res, 200, { refund })
                    : json(res, 404, { error: 'refund not found', effectId });
            }
            if (req.method === 'POST' && url.pathname === '/refund') {
                const outcome = store.refund(await readJson(req));
                if (req.headers['x-drop-response'] === '1') {
                    req.socket.destroy();
                    return undefined;
                }
                return json(res, outcome.duplicate ? 200 : 201, outcome);
            }
            return json(res, 404, { error: 'not found' });
        } catch (error) {
            if (!res.headersSent) return json(res, 400, { error: error.message });
            return res.destroy(error);
        }
    });
}

if (require.main === module) {
    const port = Number.parseInt(process.env.PORT || '6000', 10);
    const filePath = process.env.DATA_FILE || '/data/refunds.json';
    const store = new RefundStore(filePath);
    createServer({ store }).listen(port, () => {
        console.log(`[refund-provider] listening on ${port}; data=${filePath}`);
    });
}

module.exports = { RefundStore, createServer };
