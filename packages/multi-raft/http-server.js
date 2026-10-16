'use strict';

/**
 * http-server.js — a MultiRaftNode over HTTP (IV-B.0: the HTTP transport only,
 * with range-prefixed endpoints; CLOUDPROOF-PHASE-IV-B.md §13).
 *
 *   POST /ranges/:rangeId/append-entries | request-vote | pre-vote   Raft RPCs
 *   POST /ranges/:rangeId/kv                                         routed write
 *   GET  /ranges/:rangeId/kv/:key?epoch=N                            linearizable read
 *   GET  /ranges/:rangeId/ledger | state                             gate evidence
 *   GET  /status, /health
 *   POST /admin/ranges/:rangeId/crash | restart                      test control
 *
 * Plain node:http, no dependency. Write outcomes map to status codes so a
 * client can tell "definitely not applied" from "unknown":
 *   200 OK · 409 STALE_RANGE_EPOCH · 421 NOT_LEADER · 503 UNAVAILABLE · 504 UNKNOWN
 */

const http = require('http');

const WRITE_STATUS = Object.freeze({ OK: 200, STALE_RANGE_EPOCH: 409, NOT_LEADER: 421, UNAVAILABLE: 503, UNKNOWN: 504 });
const MAX_BODY = 4 * 1024 * 1024;

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve({});
            try { resolve(JSON.parse(text)); } catch (_) { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
        });
        req.on('error', reject);
    });
}

function send(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length });
    res.end(payload);
}

function createMultiRaftServer(node, { admin = true } = {}) {
    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://local');
            const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
            if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, nodeId: node.nodeId });
            if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, { nodeId: node.nodeId, ranges: node.status() });

            if (parts[0] === 'ranges' && parts.length >= 3) {
                const [, rangeId, action, ...rest] = parts;
                if (req.method === 'POST' && ['append-entries', 'request-vote', 'pre-vote'].includes(action) && !rest.length) {
                    const body = await readBody(req);
                    try {
                        return send(res, 200, await node.rpc(rangeId, action, body));
                    } catch (error) {
                        return send(res, error.code === 'ENOENT' ? 404 : 503, { error: error.message });
                    }
                }
                if (req.method === 'POST' && action === 'kv' && !rest.length) {
                    const body = await readBody(req);
                    const outcome = await node.write({ ...body, rangeId });
                    return send(res, WRITE_STATUS[outcome.status] || 500, outcome);
                }
                if (req.method === 'GET' && action === 'kv' && rest.length === 1) {
                    const epoch = url.searchParams.has('epoch') ? Number(url.searchParams.get('epoch')) : null;
                    const outcome = await node.read({ rangeId, expectedRangeEpoch: epoch, key: rest[0] });
                    return send(res, WRITE_STATUS[outcome.status] || 500, outcome);
                }
                if (req.method === 'GET' && action === 'ledger' && !rest.length) {
                    const ledger = node.ledger(rangeId);
                    return ledger ? send(res, 200, { rangeId, nodeId: node.nodeId, ledger }) : send(res, 503, { error: 'range down or not hosted' });
                }
                if (req.method === 'GET' && action === 'state' && !rest.length) {
                    const state = node.state(rangeId);
                    return state ? send(res, 200, { rangeId, nodeId: node.nodeId, state }) : send(res, 503, { error: 'range down or not hosted' });
                }
            }
            if (admin && req.method === 'POST' && parts[0] === 'admin' && parts[1] === 'ranges' && parts.length === 4) {
                const [, , rangeId, action] = parts;
                if (action === 'crash') return send(res, 200, { ok: node.crashGroup(rangeId) });
                if (action === 'restart') return send(res, 200, { ok: node.restartGroup(rangeId) });
            }
            return send(res, 404, { error: `no route ${req.method} ${url.pathname}` });
        } catch (error) {
            return send(res, error.status || 500, { error: error.message });
        }
    });
}

module.exports = { createMultiRaftServer, WRITE_STATUS };
