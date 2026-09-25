'use strict';

/**
 * profile.js — reduces a V8 .cpuprofile to the numbers that answer "where does
 * the CPU go?".
 *
 * Self time is attributed per sample (the time until the next sample), so it is
 * wall-clock time the profiler saw that frame on top of the stack. Categories
 * are assigned from the top frame's script URL and function name. Inclusive
 * time is computed per function by walking each sample's stack once, counting a
 * function at most once per sample so recursion does not double count.
 *
 * `(idle)` is time the main thread waited in the event loop with nothing to
 * do; `(program)` is native work V8 could not attribute to a JS frame. On this
 * workload, synchronous fsync appears as self time in `fsyncSync` (the thread
 * is blocked inside the call), which is exactly what the report needs to show.
 */

const crypto = require('crypto');

const CATEGORY_RULES = [
    ['idle', (f) => f.functionName === '(idle)'],
    ['gc', (f) => f.functionName === '(garbage collector)'],
    ['program', (f) => f.functionName === '(program)'],
    ['fs-sync-io', (f) => /^(fsyncSync|writeSync|openSync|closeSync|renameSync|writeFileSync|readFileSync|mkdirSync|rmSync|fdatasyncSync|fsync|fdatasync|write|writev)$/.test(f.functionName)
        && (f.url === 'node:fs' || f.url === '' || f.url.startsWith('node:internal/fs'))],
    ['fs-other', (f) => f.url === 'node:fs' || f.url.startsWith('node:internal/fs')],
    ['console-logging', (f) => f.url.startsWith('node:internal/console') || f.url.startsWith('node:internal/util/inspect')],
    ['raft-log-store', (f) => /replica[\\/]log-store\.js$/.test(f.url)],
    ['raft-engine', (f) => /replica[\\/]raft\.js$/.test(f.url)],
    ['raft-transport', (f) => /replica[\\/]raft-(transport|codec)\.js$/.test(f.url)],
    ['state-machine', (f) => /replica[\\/](state-machine|agent-state|hnsw)\.js$/.test(f.url)],
    ['instrumentation', (f) => /replica[\\/](raft-perf|perf-histogram|perf-service)\.js$/.test(f.url)],
    ['replica-http-routes', (f) => /replica[\\/]index\.js$/.test(f.url)],
    ['express', (f) => /node_modules[\\/](express|body-parser|raw-body|iconv-lite|finalhandler|send|serve-static|on-finished|type-is|content-type|qs|depd|router|path-to-regexp|media-typer|mime|accepts|negotiator|etag|fresh|parseurl|proxy-addr|forwarded|statuses|http-errors|destroy|encodeurl|escape-html|merge-descriptors|methods|cookie|vary|content-disposition|bytes|unpipe|ee-first|setprototypeof|inherits|safe-buffer|safer-buffer|toidentifier|utils-merge|array-flatten|side-channel|object-inspect|call-bind|get-intrinsic|es-|gopd|has-|hasown|function-bind|dunder-proto|math-intrinsics)/.test(f.url)],
    ['axios', (f) => /node_modules[\\/](axios|follow-redirects|form-data|proxy-from-env|combined-stream|asynckit|delayed-stream|mime-types|mime-db|debug|ms)/.test(f.url)],
    ['json', (f) => f.url === '' && /^(stringify|parse|JSONStringify|JSONParse)$/.test(f.functionName)],
    ['node-http', (f) => /^node:(_http_|http|internal\/http)/.test(f.url)],
    ['streams-net', (f) => /^node:(net|stream|internal\/stream|internal\/streams|internal\/net|internal\/stream_base_commons|dgram|dns|internal\/dns)/.test(f.url)],
    ['timers-microtasks', (f) => /^node:(timers|internal\/timers|internal\/process\/task_queues|internal\/async_hooks)/.test(f.url)],
    ['buffer-string', (f) => /^node:(buffer|internal\/buffer|string_decoder|internal\/util)/.test(f.url)],
    ['node-internal-other', (f) => f.url.startsWith('node:')],
    ['v8-builtin', (f) => f.url === ''],
];

function categoryOf(frame) {
    for (const [name, test] of CATEGORY_RULES) if (test(frame)) return name;
    return 'other';
}

// Native fs bindings as they appear in V8 profiles (Node 24).
const FS_NATIVE = new Set([
    'fsync', 'fdatasync', 'open', 'close', 'rename', 'writeFileUtf8', 'mkdir', 'writeBuffer',
    'writeString', 'writeBuffers', 'read', 'readFileUtf8', 'unlink', 'rmSync', 'fstat', 'lstat',
    'stat', 'ftruncate', 'existsSync', 'internalModuleStat',
]);

/**
 * Native bindings (`rename`, `open`, `writeBuffer`, `consoleCall`, ...) have no
 * script URL, and several names are shared between fs and sockets. They are
 * categorized by their nearest ancestor frame that has one: a `writeBuffer`
 * under node:fs is disk I/O, the same name under node:net is a socket write.
 */
function categoryWithContext(frame, ancestors) {
    if (frame.url !== '' || /^\((idle|garbage collector|program|root)\)$/.test(frame.functionName)) {
        return categoryOf(frame);
    }
    if (/^(stringify|parse|JSONStringify|JSONParse)$/.test(frame.functionName)) return 'json';
    if (frame.functionName === 'consoleCall') return 'console-logging';
    const caller = ancestors.find((ancestor) => ancestor.url);
    if (!caller) return 'v8-builtin';
    const fsCaller = caller.url === 'node:fs' || caller.url.startsWith('node:internal/fs')
        || /replica[\\/][\w-]+\.js$/.test(caller.url);
    if (fsCaller && FS_NATIVE.has(frame.functionName)) return 'fs-sync-io';
    return categoryOf(caller);
}

function frameKey(frame) {
    const file = frame.url ? frame.url.replace(/^.*[\\/](node_modules[\\/].*|replica[\\/].*|packages[\\/].*)$/, '$1') : '';
    return `${frame.functionName || '(anonymous)'} ${file}${frame.url ? `:${frame.lineNumber + 1}` : ''}`;
}

function summarizeProfile(profile, { topN = 30, label = null } = {}) {
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const parent = new Map();
    for (const node of profile.nodes) for (const child of node.children || []) parent.set(child, node.id);

    const intervals = profile.timeDeltas.slice(1);
    const sorted = [...intervals].sort((a, b) => a - b);
    const medianInterval = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

    const selfByCategory = new Map();
    const selfByFrame = new Map();
    const inclusiveByFrame = new Map();
    const folded = new Map();
    let totalMicros = 0;

    for (let i = 0; i < profile.samples.length; i += 1) {
        const micros = i + 1 < profile.timeDeltas.length ? profile.timeDeltas[i + 1] : medianInterval;
        if (micros <= 0) continue;
        const nodeId = profile.samples[i];
        const node = nodes.get(nodeId);
        if (!node) continue;
        totalMicros += micros;
        const frame = node.callFrame;
        const ancestors = [];
        for (let id = parent.get(nodeId); id !== undefined && ancestors.length < 8; id = parent.get(id)) {
            const n = nodes.get(id);
            if (n) ancestors.push(n.callFrame);
        }
        const category = categoryWithContext(frame, ancestors);
        selfByCategory.set(category, (selfByCategory.get(category) || 0) + micros);
        const key = frameKey(frame);
        const self = selfByFrame.get(key) || { micros: 0, category };
        self.micros += micros;
        selfByFrame.set(key, self);

        const seen = new Set();
        const stack = [];
        for (let id = nodeId; id !== undefined; id = parent.get(id)) {
            const n = nodes.get(id);
            if (!n || n.callFrame.functionName === '(root)') continue;
            const k = frameKey(n.callFrame);
            stack.push(k);
            if (seen.has(k)) continue;
            seen.add(k);
            inclusiveByFrame.set(k, (inclusiveByFrame.get(k) || 0) + micros);
        }
        const foldedKey = stack.reverse().join(';');
        folded.set(foldedKey, (folded.get(foldedKey) || 0) + micros);
    }

    const pct = (micros) => (totalMicros ? Number(((micros / totalMicros) * 100).toFixed(2)) : 0);
    const busyMicros = totalMicros - (selfByCategory.get('idle') || 0);
    const pctBusy = (micros) => (busyMicros ? Number(((micros / busyMicros) * 100).toFixed(2)) : 0);

    const categories = [...selfByCategory.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([category, micros]) => ({
            category, ms: Number((micros / 1000).toFixed(1)), percentOfWall: pct(micros),
            percentOfBusy: category === 'idle' ? null : pctBusy(micros),
        }));
    const topSelf = [...selfByFrame.entries()]
        .sort((a, b) => b[1].micros - a[1].micros)
        .slice(0, topN)
        .map(([frame, { micros, category }]) => ({ frame, category, ms: Number((micros / 1000).toFixed(1)), percentOfWall: pct(micros), percentOfBusy: pctBusy(micros) }));
    const topInclusive = [...inclusiveByFrame.entries()]
        .filter(([frame]) => !/^\((program|idle|garbage collector)\)/.test(frame))
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([frame, micros]) => ({ frame, ms: Number((micros / 1000).toFixed(1)), percentOfWall: pct(micros), percentOfBusy: pctBusy(micros) }));

    // A few named paths the report refers to directly.
    const inclusiveMatching = (pattern) => {
        let micros = 0;
        for (const [frame, value] of inclusiveByFrame) if (pattern.test(frame)) micros = Math.max(micros, value);
        return { ms: Number((micros / 1000).toFixed(1)), percentOfWall: pct(micros), percentOfBusy: pctBusy(micros) };
    };
    const keyPaths = {
        'LogStore.append (encode+write+fsync)': inclusiveMatching(/^append replica[\\/]log-store\.js/),
        'StableStateStore.save (metadata persist)': inclusiveMatching(/^save replica[\\/]raft\.js/),
        'RaftNode.clientAppend': inclusiveMatching(/^clientAppend replica[\\/]raft\.js/),
        'RaftNode.handleAppendEntries': inclusiveMatching(/^handleAppendEntries replica[\\/]raft\.js/),
        'RaftNode._replicateToPeer': inclusiveMatching(/^_replicateToPeer replica[\\/]raft\.js/),
        'RaftNode._advanceCommitIndex': inclusiveMatching(/^_advanceCommitIndex replica[\\/]raft\.js/),
        'express jsonParser': inclusiveMatching(/^jsonParser node_modules[\\/]body-parser/),
        'axios request': inclusiveMatching(/^(dispatchHttpRequest|httpAdapter) node_modules[\\/]axios/),
        'console.log': inclusiveMatching(/^log node:internal\/console/),
    };

    return {
        schema: 'cloudproof.raft-bench.profile-summary/v1',
        label,
        sampledWallMs: Number((totalMicros / 1000).toFixed(1)),
        samples: profile.samples.length,
        medianSampleIntervalUs: medianInterval,
        busyPercentOfWall: pct(busyMicros),
        categories,
        topSelf,
        topInclusive,
        keyPaths,
        foldedStacks: [...folded.entries()].sort((a, b) => b[1] - a[1]),
    };
}

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

module.exports = { summarizeProfile, categoryOf, categoryWithContext, sha256 };
