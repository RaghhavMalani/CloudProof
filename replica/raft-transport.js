'use strict';

/**
 * raft-transport.js — framed TCP for Raft RPCs (Phase IV-A transport experiment).
 *
 * A drop-in for the `transport` a RaftNode takes: `post(url, body, {timeout})`
 * resolving to `{ data }`, exactly like axios, so the engine cannot tell which
 * transport it is using. Peers are still named by their HTTP URL; the Raft
 * listener of a peer is its HTTP port plus `portOffset`.
 *
 * One persistent connection per peer, many requests multiplexed on it by
 * stream id. TCP's ordering means pipelined AppendEntries arrive in the order
 * they were sent — which HTTP/1.1 over a pool of connections does not promise —
 * while responses may return in any order (a group-commit follower answers
 * when its flush completes). A broken connection fails every request on it;
 * the next request reconnects.
 */

const net = require('net');
const {
    TYPES, ROUTE_TYPES, CodecError, encodeRequest, encodeResponse, encodeError, decodeBody, FrameDecoder,
} = require('./raft-codec');

function transportError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
}

class PeerConnection {
    constructor({ host, port, onSocket }) {
        this.host = host;
        this.port = port;
        this.onSocket = onSocket;
        this.socket = null;
        this.pending = new Map(); // streamId -> { resolve, reject, timer }
        this.nextStream = 1;
    }

    _connect() {
        const socket = net.connect({ host: this.host, port: this.port });
        socket.setNoDelay(true);
        const decoder = new FrameDecoder();
        socket.on('data', (chunk) => {
            let frames;
            try {
                frames = decoder.push(chunk);
            } catch (error) {
                socket.destroy(error);
                return;
            }
            for (const frame of frames) this._onFrame(frame);
        });
        const fail = (error) => {
            if (this.socket === socket) this.socket = null;
            const reason = transportError(error && error.code ? error.code : 'ECONNRESET', error ? error.message : 'connection closed');
            for (const [, request] of this.pending) {
                clearTimeout(request.timer);
                request.reject(reason);
            }
            this.pending.clear();
        };
        socket.on('error', fail);
        socket.on('close', () => fail(null));
        if (this.onSocket) this.onSocket(socket);
        this.socket = socket;
        return socket;
    }

    _onFrame({ type, streamId, body }) {
        const request = this.pending.get(streamId);
        if (!request) return; // timed out already; the late answer is dropped
        this.pending.delete(streamId);
        clearTimeout(request.timer);
        try {
            const data = decodeBody(type, body);
            if (type === TYPES.ERROR) request.reject(transportError('EREMOTE', data.message));
            else request.resolve({ data });
        } catch (error) {
            request.reject(error);
        }
    }

    request(type, body, timeoutMs) {
        return new Promise((resolve, reject) => {
            const socket = this.socket && !this.socket.destroyed ? this.socket : this._connect();
            const streamId = this.nextStream;
            this.nextStream = (this.nextStream % 0xfffffffe) + 1;
            let frame;
            try {
                frame = encodeRequest(type, body, streamId);
            } catch (error) {
                reject(error);
                return;
            }
            const timer = setTimeout(() => {
                if (this.pending.delete(streamId)) reject(transportError('ETIMEDOUT', `timeout of ${timeoutMs}ms exceeded`));
            }, timeoutMs);
            if (timer.unref) timer.unref();
            this.pending.set(streamId, { resolve, reject, timer });
            socket.write(frame);
        });
    }

    close() {
        if (this.socket) this.socket.destroy();
        this.socket = null;
    }
}

class FramedTcpTransport {
    constructor({ portOffset = 1000, onSocket = null } = {}) {
        this.portOffset = portOffset;
        this.onSocket = onSocket;
        this.connections = new Map();
    }

    _connectionFor(origin) {
        let connection = this.connections.get(origin);
        if (!connection) {
            const url = new URL(origin);
            connection = new PeerConnection({
                host: url.hostname,
                port: Number(url.port || 80) + this.portOffset,
                onSocket: this.onSocket,
            });
            this.connections.set(origin, connection);
        }
        return connection;
    }

    /** axios-compatible: resolves `{ data }`, rejects on timeout or connection failure. */
    post(url, body, { timeout = 450 } = {}) {
        const parsed = new URL(url);
        const type = ROUTE_TYPES[parsed.pathname];
        if (!type) return Promise.reject(new Error(`framed transport has no route ${parsed.pathname}`));
        return this._connectionFor(parsed.origin).request(type, body, timeout);
    }

    close() {
        for (const connection of this.connections.values()) connection.close();
        this.connections.clear();
    }
}

/**
 * The listening side. `handlers` maps message types to functions returning
 * a response object or a promise of one.
 */
function createFramedTcpServer({ handlers, onSocket = null }) {
    const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        if (onSocket) onSocket(socket);
        const decoder = new FrameDecoder();
        const reply = (buffer) => { if (!socket.destroyed) socket.write(buffer); };
        socket.on('data', (chunk) => {
            let frames;
            try {
                frames = decoder.push(chunk);
            } catch (error) {
                reply(encodeError(error.message, 0));
                socket.destroy();
                return;
            }
            for (const { type, streamId, body } of frames) {
                const handler = handlers[type];
                if (!handler) {
                    reply(encodeError(`no handler for message type ${type}`, streamId));
                    continue;
                }
                let result;
                try {
                    result = handler(decodeBody(type, body));
                } catch (error) {
                    reply(encodeError(error.message, streamId));
                    continue;
                }
                if (result && typeof result.then === 'function') {
                    result.then(
                        (data) => reply(encodeResponse(type, data, streamId)),
                        (error) => reply(encodeError(error.message, streamId)),
                    );
                } else {
                    reply(encodeResponse(type, result, streamId));
                }
            }
        });
        socket.on('error', () => socket.destroy());
    });
    return server;
}

/** Handlers for a RaftNode, keyed by message type. */
function raftHandlers(raft) {
    return {
        [TYPES.APPEND_ENTRIES]: (body) => raft.handleAppendEntries(body),
        [TYPES.REQUEST_VOTE]: (body) => raft.handleRequestVote(body),
        [TYPES.PRE_VOTE]: (body) => raft.handlePreVote(body),
    };
}

module.exports = { FramedTcpTransport, createFramedTcpServer, raftHandlers, CodecError };
