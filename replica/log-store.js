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
    const json = JSON.stringify(entry);
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
        const payload = entries.map(encodeRecord).join('');
        fs.writeSync(descriptor, payload);
        fs.fsyncSync(descriptor);
        this.appendCount += entries.length;
    }

    /**
     * Replaces the log wholesale. Used when a follower truncates a conflicting
     * suffix, which is rare enough that paying for a full rewrite is fine and
     * much simpler than punching a hole in an append-only file.
     */
    rewrite(entries) {
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
