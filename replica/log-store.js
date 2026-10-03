/**
 * log-store.js — an append-only, crash-safe Raft log.
 *
 * The previous implementation serialised the entire log into a single JSON
 * document on every append, which meant an O(n) fsync per entry and O(n^2)
 * bytes written over the life of a node. That is invisible at whiteboard scale
 * and fatal once leases renew at heartbeat cadence, so the log now lives in its
 * own append-only file and only the small metadata record (term, vote, commit
 * index) is rewritten in place.
 *
 * On-disk format: one record per line,
 *
 *     <crc32-hex> <json>\n
 *
 * The CRC exists to distinguish a torn tail from real corruption. A crash
 * midway through an append leaves a partial final line; that entry was never
 * acknowledged to anyone, so discarding it is safe and required. A checksum
 * failure anywhere *before* the final line is genuine corruption and throws,
 * because silently dropping a committed entry would violate the state machine
 * safety property.
 */

const fs = require('fs');
const path = require('path');
const { entryJson } = require('./entry-codec');

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

function crc32(text) {
    const bytes = Buffer.from(text, 'utf8');
    let crc = -1;
    for (let i = 0; i < bytes.length; i += 1) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
}

function encodeRecord(entry) {
    // Cached per entry object: the same text is reused if this entry is later
    // replicated by a transport that can carry raw entry JSON.
    const json = entryJson(entry);
    return `${crc32(json).toString(16).padStart(8, '0')} ${json}\n`;
}

function fsyncDirectory(directory) {
    // Renaming a file is only durable once the containing directory is synced.
    // Linux (the deployment target) supports this; some local filesystems do
    // not allow opening a directory handle, and there the guarantee is weaker.
    try {
        const descriptor = fs.openSync(directory, 'r');
        try {
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
    } catch (_) {
        /* best effort */
    }
}

class LogStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.directory = path.dirname(filePath);
        this._descriptor = null;
        this.truncatedTailBytes = 0;
        this.appendCount = 0;
        this.fsyncCount = 0;
        // Optional observational recorder (raft-perf.js); never affects I/O.
        this.perf = null;
        // Group commit: encoded records appended but not yet written+fsynced.
        this._pending = [];
        this._pendingEntries = 0;
        this._pendingSince = 0;
    }

    /** Entries appended with appendBuffered() and not yet flushed. */
    get pendingCount() {
        return this._pendingEntries;
    }

    setPerf(perf) {
        this.perf = perf;
    }

    /**
     * Reads the log back from disk. Returns the recovered entries; the caller
     * owns them from that point on and mirrors them in memory.
     */
    load() {
        let raw;
        try {
            raw = fs.readFileSync(this.filePath, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return [];
        }

        const lines = raw.split('\n');
        // A trailing newline produces a final empty element; a torn write does
        // not. Either way the last element is the only one allowed to be bad.
        const trailing = lines.pop();
        if (trailing !== '') this.truncatedTailBytes = Buffer.byteLength(trailing, 'utf8');

        const entries = [];
        for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
            const line = lines[lineNumber];
            if (line === '') continue;

            const separator = line.indexOf(' ');
            const checksum = separator > 0 ? line.slice(0, separator) : '';
            const json = separator > 0 ? line.slice(separator + 1) : '';

            if (crc32(json).toString(16).padStart(8, '0') !== checksum) {
                throw new Error(
                    `Raft log corrupted at ${this.filePath}:${lineNumber + 1} — ` +
                    'checksum mismatch on a complete record',
                );
            }

            const entry = JSON.parse(json);
            if (entry.index !== entries.length) {
                throw new Error(
                    `Raft log corrupted at ${this.filePath}:${lineNumber + 1} — ` +
                    `expected index ${entries.length}, found ${entry.index}`,
                );
            }
            entries.push(entry);
        }

        if (this.truncatedTailBytes > 0) {
            // Rewrite so the next append does not sit behind a partial record.
            this.rewrite(entries);
            console.warn(
                `[log-store] discarded ${this.truncatedTailBytes}B torn tail from ${this.filePath}; ` +
                `${entries.length} entries recovered`,
            );
        }

        return entries;
    }

    _open() {
        if (this._descriptor === null) {
            fs.mkdirSync(this.directory, { recursive: true });
            this._descriptor = fs.openSync(this.filePath, 'a', 0o600);
        }
        return this._descriptor;
    }

    /**
     * Appends entries and returns only once they are on stable storage. One
     * fsync covers the whole batch, so replicating twenty entries costs one
     * disk round trip rather than twenty.
     */
    append(entries) {
        if (entries.length === 0) return;
        const descriptor = this._open();
        const perf = this.perf;
        const encodeStartedAt = perf ? perf.now() : 0;
        const payload = entries.map(encodeRecord).join('');
        const writeStartedAt = perf ? perf.now() : 0;
        fs.writeSync(descriptor, payload);
        const fsyncStartedAt = perf ? perf.now() : 0;
        fs.fsyncSync(descriptor);
        this.appendCount += entries.length;
        this.fsyncCount += 1;
        if (perf) {
            const doneAt = perf.now();
            perf.observeMs('log.encode', writeStartedAt - encodeStartedAt);
            perf.observeMs('log.write', fsyncStartedAt - writeStartedAt);
            perf.observeMs('log.fsync', doneAt - fsyncStartedAt);
            perf.observeValue('log.entriesPerFsync', entries.length);
            perf.count('log.fsyncs');
            perf.count('log.entriesWritten', entries.length);
            perf.count('log.bytesWritten', Buffer.byteLength(payload, 'utf8'));
        }
    }

    /**
     * Group commit, first half: encode now, write later. Nothing appended this
     * way is durable, and the caller must not act as if it were, until
     * flush() returns.
     */
    appendBuffered(entries) {
        if (entries.length === 0) return;
        const perf = this.perf;
        const encodeStartedAt = perf ? perf.now() : 0;
        for (const entry of entries) this._pending.push(encodeRecord(entry));
        if (this._pendingEntries === 0 && perf) this._pendingSince = encodeStartedAt;
        this._pendingEntries += entries.length;
        if (perf) perf.observeMs('log.encode', perf.now() - encodeStartedAt);
    }

    /**
     * Group commit, second half: one write and one fsync for every buffered
     * record, in append order. Returns the number of entries made durable.
     */
    flush() {
        if (this._pendingEntries === 0) return 0;
        const descriptor = this._open();
        const perf = this.perf;
        const payload = this._pending.join('');
        const count = this._pendingEntries;
        const writeStartedAt = perf ? perf.now() : 0;
        fs.writeSync(descriptor, payload);
        const fsyncStartedAt = perf ? perf.now() : 0;
        fs.fsyncSync(descriptor);
        this._pending = [];
        this._pendingEntries = 0;
        this.appendCount += count;
        this.fsyncCount += 1;
        if (perf) {
            const doneAt = perf.now();
            perf.observeMs('groupCommit.oldestWait', writeStartedAt - this._pendingSince);
            perf.observeMs('log.write', fsyncStartedAt - writeStartedAt);
            perf.observeMs('log.fsync', doneAt - fsyncStartedAt);
            perf.observeValue('log.entriesPerFsync', count);
            perf.count('log.fsyncs');
            perf.count('log.entriesWritten', count);
            perf.count('log.bytesWritten', Buffer.byteLength(payload, 'utf8'));
        }
        return count;
    }

    /**
     * Replaces the log wholesale. Used when a follower truncates a conflicting
     * suffix, which is rare enough that paying for a full rewrite is fine and
     * much simpler than punching a hole in an append-only file.
     *
     * `entries` is the complete in-memory log, which includes anything still
     * buffered, so the buffer is discarded: the rewrite makes it durable.
     */
    rewrite(entries) {
        this._pending = [];
        this._pendingEntries = 0;
        fs.mkdirSync(this.directory, { recursive: true });
        if (this._descriptor !== null) {
            fs.closeSync(this._descriptor);
            this._descriptor = null;
        }

        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        const descriptor = fs.openSync(temporaryPath, 'w', 0o600);
        try {
            fs.writeSync(descriptor, entries.map(encodeRecord).join(''));
            fs.fsyncSync(descriptor);
            this.fsyncCount += 1;
            if (this.perf) this.perf.count('log.rewrites');
        } finally {
            fs.closeSync(descriptor);
        }

        try {
            fs.renameSync(temporaryPath, this.filePath);
        } catch (error) {
            // Windows can refuse replace-on-rename. Containers take the atomic
            // branch above; this keeps local development usable.
            if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
            fs.rmSync(this.filePath, { force: true });
            fs.renameSync(temporaryPath, this.filePath);
        }

        fsyncDirectory(this.directory);
    }

    close() {
        if (this._descriptor !== null) {
            fs.closeSync(this._descriptor);
            this._descriptor = null;
        }
    }
}

module.exports = { LogStore, crc32 };
