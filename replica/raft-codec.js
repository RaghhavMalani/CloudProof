'use strict';

/**
 * raft-codec.js — the framed binary wire format for replica-to-replica RPCs.
 *
 * Frame (big-endian):
 *
 *   offset  size  field
 *   0       u32   body length (bytes after this 12-byte header)
 *   4       u8    protocol version (1)
 *   5       u8    message type
 *   6       u16   flags (reserved, 0)
 *   8       u32   stream id (request/response correlation)
 *   12      ...   body
 *
 * Message types and bodies:
 *
 *   1 APPEND_ENTRIES           f64 term, f64 prevLogIndex, f64 prevLogTerm,
 *                              f64 leaderCommit, str leaderId, str leaderUrl,
 *                              u32 count, count x (u32 length + entry JSON)
 *   2 APPEND_ENTRIES_RESPONSE  u8 flags, f64 term, f64 matchIndex,
 *                              f64 conflictIndex, f64 conflictTerm,
 *                              f64 logLength, str extra (JSON of any other field)
 *   3 REQUEST_VOTE             str JSON body
 *   4 REQUEST_VOTE_RESPONSE    str JSON body
 *   5 PRE_VOTE                 str JSON body
 *   6 PRE_VOTE_RESPONSE        str JSON body
 *   15 ERROR                   str JSON {message}
 *
 *   str = u32 byte length (0xFFFFFFFF = null) + UTF-8 bytes
 *   absent numeric fields are NaN and decode to "field not present"
 *
 * Only the hot path is binary. AppendEntries and its response carry fixed-
 * width numbers instead of JSON text, and entries travel as length-prefixed
 * JSON blobs: the command inside an entry is application data whose natural
 * form is JSON, and a leader already has that exact text cached from writing
 * its own log (entry-codec.js), so a batch to each follower is a memcpy of
 * cached bytes rather than a fresh JSON.stringify of the whole request. The
 * follower parses each entry and primes the same cache, so its log store does
 * not encode the entry again. Votes are rare and stay JSON inside a frame.
 */

const { entryJson, primeEntryJson } = require('./entry-codec');

const VERSION = 1;
const HEADER_BYTES = 12;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const NULL_STRING = 0xffffffff;

const TYPES = Object.freeze({
    APPEND_ENTRIES: 1,
    APPEND_ENTRIES_RESPONSE: 2,
    REQUEST_VOTE: 3,
    REQUEST_VOTE_RESPONSE: 4,
    PRE_VOTE: 5,
    PRE_VOTE_RESPONSE: 6,
    ERROR: 15,
});

const ROUTE_TYPES = Object.freeze({
    '/append-entries': TYPES.APPEND_ENTRIES,
    '/request-vote': TYPES.REQUEST_VOTE,
    '/pre-vote': TYPES.PRE_VOTE,
});

const RESPONSE_TYPE = Object.freeze({
    [TYPES.APPEND_ENTRIES]: TYPES.APPEND_ENTRIES_RESPONSE,
    [TYPES.REQUEST_VOTE]: TYPES.REQUEST_VOTE_RESPONSE,
    [TYPES.PRE_VOTE]: TYPES.PRE_VOTE_RESPONSE,
});

class CodecError extends Error {}

// ── writing ──────────────────────────────────────────────────────────────────

/** Accumulates body parts, then produces one frame buffer. */
class FrameWriter {
    constructor() { this.parts = []; this.length = 0; }

    f64(value) {
        const b = Buffer.allocUnsafe(8);
        b.writeDoubleBE(value === undefined || value === null ? NaN : Number(value), 0);
        this.parts.push(b); this.length += 8;
    }

    u8(value) {
        const b = Buffer.allocUnsafe(1); b.writeUInt8(value, 0);
        this.parts.push(b); this.length += 1;
    }

    u32(value) {
        const b = Buffer.allocUnsafe(4); b.writeUInt32BE(value, 0);
        this.parts.push(b); this.length += 4;
    }

    str(value) {
        if (value === null || value === undefined) { this.u32(NULL_STRING); return; }
        const bytes = Buffer.from(String(value), 'utf8');
        this.u32(bytes.length);
        this.parts.push(bytes); this.length += bytes.length;
    }

    frame(type, streamId) {
        if (this.length > MAX_FRAME_BYTES) throw new CodecError(`frame of ${this.length} bytes exceeds the ${MAX_FRAME_BYTES} limit`);
        const header = Buffer.allocUnsafe(HEADER_BYTES);
        header.writeUInt32BE(this.length, 0);
        header.writeUInt8(VERSION, 4);
        header.writeUInt8(type, 5);
        header.writeUInt16BE(0, 6);
        header.writeUInt32BE(streamId >>> 0, 8);
        return Buffer.concat([header, ...this.parts], HEADER_BYTES + this.length);
    }
}

function encodeAppendEntries(body, streamId) {
    const w = new FrameWriter();
    w.f64(body.term);
    w.f64(body.prevLogIndex ?? -1);
    w.f64(body.prevLogTerm ?? 0);
    w.f64(body.leaderCommit ?? -1);
    w.str(body.leaderId);
    w.str(body.leaderUrl);
    const entries = body.entries || [];
    w.u32(entries.length);
    for (const entry of entries) w.str(entryJson(entry));
    return w.frame(TYPES.APPEND_ENTRIES, streamId);
}

const RESPONSE_FIELDS = ['matchIndex', 'conflictIndex', 'conflictTerm', 'logLength'];
const RESPONSE_KNOWN = new Set(['term', 'success', ...RESPONSE_FIELDS]);

function encodeAppendEntriesResponse(data, streamId) {
    const w = new FrameWriter();
    let flags = data.success ? 1 : 0;
    RESPONSE_FIELDS.forEach((field, i) => { if (data[field] !== undefined) flags |= 1 << (i + 1); });
    const extra = {};
    let hasExtra = false;
    for (const [key, value] of Object.entries(data)) {
        if (!RESPONSE_KNOWN.has(key) && value !== undefined) { extra[key] = value; hasExtra = true; }
    }
    w.u8(flags);
    w.f64(data.term);
    for (const field of RESPONSE_FIELDS) w.f64(data[field]);
    w.str(hasExtra ? JSON.stringify(extra) : null);
    return w.frame(TYPES.APPEND_ENTRIES_RESPONSE, streamId);
}

function encodeJson(type, value, streamId) {
    const w = new FrameWriter();
    w.str(JSON.stringify(value));
    return w.frame(type, streamId);
}

function encodeRequest(type, body, streamId) {
    return type === TYPES.APPEND_ENTRIES ? encodeAppendEntries(body, streamId) : encodeJson(type, body, streamId);
}

function encodeResponse(requestType, data, streamId) {
    const type = RESPONSE_TYPE[requestType];
    return type === TYPES.APPEND_ENTRIES_RESPONSE
        ? encodeAppendEntriesResponse(data, streamId)
        : encodeJson(type, data, streamId);
}

function encodeError(message, streamId) {
    return encodeJson(TYPES.ERROR, { message: String(message) }, streamId);
}

// ── reading ──────────────────────────────────────────────────────────────────

class FrameReader {
    constructor(buffer) { this.b = buffer; this.o = 0; }

    need(n) { if (this.o + n > this.b.length) throw new CodecError('truncated frame body'); }
    f64() { this.need(8); const v = this.b.readDoubleBE(this.o); this.o += 8; return v; }
    u8() { this.need(1); const v = this.b.readUInt8(this.o); this.o += 1; return v; }
    u32() { this.need(4); const v = this.b.readUInt32BE(this.o); this.o += 4; return v; }

    str() {
        const length = this.u32();
        if (length === NULL_STRING) return null;
        this.need(length);
        const value = this.b.toString('utf8', this.o, this.o + length);
        this.o += length;
        return value;
    }

    done() { if (this.o !== this.b.length) throw new CodecError(`${this.b.length - this.o} trailing bytes in frame body`); }
}

const num = (value) => (Number.isNaN(value) ? undefined : value);

function decodeAppendEntries(body) {
    const r = new FrameReader(body);
    const message = {
        term: r.f64(),
        prevLogIndex: r.f64(),
        prevLogTerm: r.f64(),
        leaderCommit: r.f64(),
        leaderId: r.str(),
        leaderUrl: r.str(),
        entries: [],
    };
    const count = r.u32();
    for (let i = 0; i < count; i += 1) {
        const json = r.str();
        const entry = JSON.parse(json);
        // The text we received is exactly JSON.stringify of what we parsed
        // (same writer, key order preserved), so the follower's log store can
        // reuse it instead of encoding the entry again.
        primeEntryJson(entry, json);
        message.entries.push(entry);
    }
    r.done();
    return message;
}

function decodeAppendEntriesResponse(body) {
    const r = new FrameReader(body);
    const flags = r.u8();
    const data = { term: r.f64(), success: Boolean(flags & 1) };
    RESPONSE_FIELDS.forEach((field, i) => {
        const value = r.f64();
        if (flags & (1 << (i + 1))) data[field] = num(value);
    });
    const extra = r.str();
    r.done();
    if (extra !== null) Object.assign(data, JSON.parse(extra));
    return data;
}

function decodeJson(body) {
    const r = new FrameReader(body);
    const text = r.str();
    r.done();
    return JSON.parse(text);
}

function decodeBody(type, body) {
    switch (type) {
        case TYPES.APPEND_ENTRIES: return decodeAppendEntries(body);
        case TYPES.APPEND_ENTRIES_RESPONSE: return decodeAppendEntriesResponse(body);
        case TYPES.REQUEST_VOTE:
        case TYPES.REQUEST_VOTE_RESPONSE:
        case TYPES.PRE_VOTE:
        case TYPES.PRE_VOTE_RESPONSE:
        case TYPES.ERROR:
            return decodeJson(body);
        default:
            throw new CodecError(`unknown message type ${type}`);
    }
}

/**
 * Reassembles frames from a byte stream. TCP delivers bytes, not messages:
 * one chunk may hold half a frame or several frames, so frames are cut out of
 * an accumulating buffer only once their full length has arrived.
 */
class FrameDecoder {
    constructor({ maxFrameBytes = MAX_FRAME_BYTES } = {}) {
        this.maxFrameBytes = maxFrameBytes;
        this.buffer = Buffer.alloc(0);
    }

    /** Returns the complete frames in `chunk` (plus anything buffered). */
    push(chunk) {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        const frames = [];
        while (this.buffer.length >= HEADER_BYTES) {
            const length = this.buffer.readUInt32BE(0);
            if (length > this.maxFrameBytes) throw new CodecError(`frame of ${length} bytes exceeds the ${this.maxFrameBytes} limit`);
            const version = this.buffer.readUInt8(4);
            if (version !== VERSION) throw new CodecError(`unsupported protocol version ${version}`);
            if (this.buffer.length < HEADER_BYTES + length) break;
            const type = this.buffer.readUInt8(5);
            const streamId = this.buffer.readUInt32BE(8);
            const body = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
            frames.push({ type, streamId, body, bytes: HEADER_BYTES + length });
            this.buffer = this.buffer.subarray(HEADER_BYTES + length);
        }
        return frames;
    }
}

module.exports = {
    VERSION,
    HEADER_BYTES,
    MAX_FRAME_BYTES,
    TYPES,
    ROUTE_TYPES,
    RESPONSE_TYPE,
    CodecError,
    encodeRequest,
    encodeResponse,
    encodeError,
    decodeBody,
    FrameDecoder,
};
