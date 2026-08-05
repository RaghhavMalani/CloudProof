const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LogStore } = require('./log-store');

function temporaryLog(name) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `miniraft-${name}-`));
    return {
        directory,
        file: path.join(directory, 'raft.log'),
        cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
}

const entry = (index, term = 1) => ({ term, index, ts: 1000 + index, data: { op: 'set', key: `k${index}`, value: index } });

test('round-trips appended entries', () => {
    const temp = temporaryLog('roundtrip');
    try {
        const store = new LogStore(temp.file);
        store.append([entry(0), entry(1)]);
        store.append([entry(2)]);
        store.close();

        const recovered = new LogStore(temp.file).load();
        assert.equal(recovered.length, 3);
        assert.deepEqual(recovered[2], entry(2));
    } finally {
        temp.cleanup();
    }
});

test('discards a torn final record and keeps everything before it', () => {
    const temp = temporaryLog('torn');
    try {
        const store = new LogStore(temp.file);
        store.append([entry(0), entry(1), entry(2)]);
        store.close();

        // Simulate a crash midway through writing the third record.
        const raw = fs.readFileSync(temp.file, 'utf8');
        const cutPoint = raw.lastIndexOf('\n', raw.length - 2) + 1;
        const torn = raw.slice(0, cutPoint + 12);
        fs.writeFileSync(temp.file, torn);

        const reopened = new LogStore(temp.file);
        const recovered = reopened.load();

        assert.equal(recovered.length, 2, 'the two complete records survive');
        assert.ok(reopened.truncatedTailBytes > 0, 'the partial record was detected');

        // Recovery rewrites the file, so the next append lands cleanly rather
        // than behind a partial line.
        reopened.append([entry(2)]);
        reopened.close();
        assert.equal(new LogStore(temp.file).load().length, 3);
    } finally {
        temp.cleanup();
    }
});

test('refuses to load a log corrupted before the final record', () => {
    const temp = temporaryLog('corrupt');
    try {
        const store = new LogStore(temp.file);
        store.append([entry(0), entry(1), entry(2)]);
        store.close();

        // Flip a byte inside the first record's payload. This is not a torn
        // write, so silently dropping it would lose a committed entry.
        const lines = fs.readFileSync(temp.file, 'utf8').split('\n');
        lines[0] = lines[0].replace('"value":0', '"value":9');
        fs.writeFileSync(temp.file, lines.join('\n'));

        assert.throws(() => new LogStore(temp.file).load(), /checksum mismatch/);
    } finally {
        temp.cleanup();
    }
});

test('rewrite replaces the log atomically for suffix truncation', () => {
    const temp = temporaryLog('rewrite');
    try {
        const store = new LogStore(temp.file);
        store.append([entry(0), entry(1), entry(2), entry(3)]);
        store.rewrite([entry(0), entry(1)]);
        store.append([entry(2, 5)]);
        store.close();

        const recovered = new LogStore(temp.file).load();
        assert.equal(recovered.length, 3);
        assert.equal(recovered[2].term, 5, 'the conflicting suffix was replaced');
    } finally {
        temp.cleanup();
    }
});
