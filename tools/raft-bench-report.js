#!/usr/bin/env node
'use strict';

/**
 * raft-bench-report.js — generates every Phase IV-A table from the recorded
 * artifacts. No benchmark number in the write-up is typed by hand.
 *
 *   node tools/raft-bench-report.js [--root artifacts/perf/phase-iv-a] [--doc CLOUDPROOF-PHASE-IV-A.md]
 *
 * Reads <root>/<config>/sweep.json (and trials.jsonl) for every config
 * directory present, <root>/profiles/<config>/*.json, and <root>/etcd/ if
 * present. Writes:
 *
 *   <root>/summary.json        canonical cross-config summary
 *   <root>/summary.csv         one row per (config, payload, phase, rate)
 *   <root>/saturation-<N>B.svg p99 vs offered load, one line per config
 *   <root>/REPORT.md           all generated tables
 *
 * and, with --doc, replaces every `<!-- BEGIN GENERATED:<name> -->` ...
 * `<!-- END GENERATED:<name> -->` block in that document with the table of
 * the same name.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseArgs } = require('../packages/raft-bench/cli');
const { readTrials, groupTrials } = require('../packages/raft-bench/aggregate');

const ROOT = path.join(__dirname, '..');
const CONFIG_ORDER = ['baseline', 'group-commit', 'pipeline', 'batched', 'optimized', 'transport-only', 'etcd'];
const CONFIG_LABEL = {
    baseline: 'Baseline',
    'group-commit': '+ Group commit',
    pipeline: '+ Pipelined replication',
    batched: '+ Bounded batches / coalesced trigger',
    optimized: '+ Framed TCP transport (all)',
    'transport-only': 'Baseline + framed TCP only',
    etcd: 'etcd',
};

const DEFAULTS = {
    root: path.join(ROOT, 'artifacts', 'perf', 'phase-iv-a'),
    doc: null,
};

const fmt = (value, digits = 1) => (value === null || value === undefined || !Number.isFinite(value)
    ? '—' : Number(value).toFixed(digits));
const fmtInt = (value) => (value === null || value === undefined || !Number.isFinite(value)
    ? '—' : Math.round(value).toLocaleString('en-US'));

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function loadCurves(root) {
    const curves = [];
    const hashes = {};
    for (const entry of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
        if (!entry.isDirectory() || entry.name === 'profiles') continue;
        const trialsFile = path.join(root, entry.name, 'trials.jsonl');
        if (!fs.existsSync(trialsFile)) continue;
        const trials = readTrials(trialsFile);
        hashes[`${entry.name}/trials.jsonl`] = { sha256: sha256File(trialsFile), trials: trials.length };
        for (const curve of groupTrials(trials)) curves.push({ ...curve, directory: entry.name });
    }
    curves.sort((a, b) => (CONFIG_ORDER.indexOf(a.config) - CONFIG_ORDER.indexOf(b.config))
        || a.payloadBytes - b.payloadBytes);
    return { curves, hashes };
}

function pointAt(curve, fraction) {
    const knee = curve.knee.kneeRate;
    if (!knee) return null;
    const target = Math.max(1, Math.round(knee * fraction));
    const exact = curve.points.find((p) => p.phase === 'knee-fraction' && p.rate === target);
    if (exact) return { ...exact, source: 'measured at fraction' };
    if (fraction === 1) {
        const ladder = curve.points.find((p) => p.phase === 'ladder' && p.rate === knee);
        return ladder ? { ...ladder, source: 'ladder knee point' } : null;
    }
    return null;
}

function comparisonRows(curves) {
    return curves.map((curve) => {
        const at50 = pointAt(curve, 0.5);
        const at80 = pointAt(curve, 0.8);
        const atKnee = pointAt(curve, 1);
        const pick = atKnee || at80;
        return {
            config: curve.config,
            payloadBytes: curve.payloadBytes,
            kneeRate: curve.knee.kneeRate,
            maxStableThroughputPerSec: curve.knee.maxStableThroughputPerSec,
            firstUnstableRate: curve.knee.firstUnstableRate,
            peakAchievedPerSecAnyRate: curve.knee.peakAchievedPerSecAnyRate,
            p99At50Ms: at50 ? at50.latencyAllMs.p99 : null,
            p99At80Ms: at80 ? at80.latencyAllMs.p99 : null,
            p99AtKneeMs: atKnee ? atKnee.latencyAllMs.p99 : null,
            p50AtKneeMs: atKnee ? atKnee.latencyAllMs.p50 : null,
            p999AtKneeMs: atKnee ? atKnee.latencyAllMs.p999 : null,
            atKnee: pick ? {
                leaderCpuPercent: pick.leader.cpuPercentOfOneCore.mean,
                leaderCpuMicrosPerOp: pick.leader.cpuMicrosPerOp.mean,
                leaderEventLoopUtilization: pick.leader.eventLoopUtilization.mean,
                leaderLogFsyncsPerSec: pick.leader.logFsyncsPerSec.mean,
                clusterLogFsyncsPerSec: pick.cluster.logFsyncsPerSec.mean,
                clusterMetaSavesPerSec: pick.cluster.metaSavesPerSec.mean,
                appendEntriesPerSec: pick.leader.appendEntriesPerSec.mean,
                entriesPerAppend: pick.leader.entriesPerAppendMean.mean,
                entriesPerFsync: pick.leader.entriesPerFsyncMean.mean,
                replicationBytesPerOp: pick.cluster.replicationBytesPerOp.mean,
                clientBytesPerOp: pick.cluster.clientBytesPerOp.mean,
                fsyncsPerOp: pick.achievedPerSec.mean
                    ? (pick.cluster.logFsyncsPerSec.mean + pick.cluster.metaSavesPerSec.mean) / pick.achievedPerSec.mean
                    : null,
                rpcsPerOp: pick.achievedPerSec.mean
                    ? pick.leader.appendEntriesPerSec.mean / pick.achievedPerSec.mean
                    : null,
                source: pick.source,
                rate: pick.rate,
            } : null,
        };
    });
}

function curveTable(curve) {
    const lines = [
        `**${CONFIG_LABEL[curve.config] || curve.config} — ${curve.payloadBytes} B payload** `
            + `(knee ${curve.knee.kneeRate ? `${fmtInt(curve.knee.kneeRate)}/s` : 'not reached'}; `
            + `first unstable ${curve.knee.firstUnstableRate ? `${fmtInt(curve.knee.firstUnstableRate)}/s` : 'none'})`,
        '',
        '| offered/s | achieved/s | p50 ms | p95 ms | p99 ms | p99.9 ms | max ms | err % | stable | leader CPU % | ELU | fsync/s (cluster) | meta/s (cluster) | AE/s | entries/AE | repl B/op |',
        '|---:|---:|---:|---:|---:|---:|---:|---:|:---:|---:|---:|---:|---:|---:|---:|---:|',
    ];
    for (const p of curve.points.filter((x) => x.phase === 'ladder')) {
        lines.push(`| ${fmtInt(p.rate)} | ${fmtInt(p.achievedPerSec.mean)} | ${fmt(p.latencyAllMs.p50, 2)} | ${fmt(p.latencyAllMs.p95, 2)} | `
            + `${fmt(p.latencyAllMs.p99, 2)} | ${fmt(p.latencyAllMs.p999, 2)} | ${fmt(p.latencyAllMs.max, 1)} | `
            + `${fmt(p.errorRate.mean * 100, 2)} | ${p.stableVotes}/${p.repetitions} | ${fmt(p.leader.cpuPercentOfOneCore.mean, 0)} | `
            + `${fmt(p.leader.eventLoopUtilization.mean, 2)} | ${fmtInt(p.cluster.logFsyncsPerSec.mean)} | `
            + `${fmtInt(p.cluster.metaSavesPerSec.mean)} | ${fmtInt(p.leader.appendEntriesPerSec.mean)} | `
            + `${fmt(p.leader.entriesPerAppendMean.mean, 1)} | ${fmtInt(p.cluster.replicationBytesPerOp.mean)} |`);
    }
    return lines.join('\n');
}

function comparisonTable(rows, payload) {
    const lines = [
        `| configuration | max stable ops/s | p99 @50% ms | p99 @80% ms | p99 @knee ms | leader CPU % @knee | CPU µs/op | fsync+meta per op | AE RPC per op | entries/AE | repl bytes/op |`,
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ];
    for (const row of rows.filter((r) => r.payloadBytes === payload)) {
        const k = row.atKnee || {};
        lines.push(`| ${CONFIG_LABEL[row.config] || row.config} | ${fmtInt(row.maxStableThroughputPerSec)} | `
            + `${fmt(row.p99At50Ms, 2)} | ${fmt(row.p99At80Ms, 2)} | ${fmt(row.p99AtKneeMs, 2)} | `
            + `${fmt(k.leaderCpuPercent, 0)} | ${fmt(k.leaderCpuMicrosPerOp, 0)} | ${fmt(k.fsyncsPerOp, 3)} | `
            + `${fmt(k.rpcsPerOp, 3)} | ${fmt(k.entriesPerAppend, 1)} | ${fmtInt(k.replicationBytesPerOp)} |`);
    }
    return lines.join('\n');
}

function kneeTable(rows) {
    const lines = [
        '| configuration | payload | knee (offered/s) | max stable (achieved/s) | first unstable/s | peak achieved at any rate/s | p50 @knee ms | p99 @knee ms | p99.9 @knee ms |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ];
    for (const row of rows) {
        lines.push(`| ${CONFIG_LABEL[row.config] || row.config} | ${row.payloadBytes} B | ${fmtInt(row.kneeRate)} | `
            + `${fmtInt(row.maxStableThroughputPerSec)} | ${fmtInt(row.firstUnstableRate)} | ${fmtInt(row.peakAchievedPerSecAnyRate)} | `
            + `${fmt(row.p50AtKneeMs, 2)} | ${fmt(row.p99AtKneeMs, 2)} | ${fmt(row.p999AtKneeMs, 2)} |`);
    }
    return lines.join('\n');
}

function profileTable(root) {
    const dir = path.join(root, 'profiles');
    if (!fs.existsSync(dir)) return null;
    const summaries = [];
    for (const config of fs.readdirSync(dir)) {
        const configDir = path.join(dir, config);
        if (!fs.statSync(configDir).isDirectory()) continue;
        for (const file of fs.readdirSync(configDir)) {
            if (!file.endsWith('.json')) continue;
            summaries.push(JSON.parse(fs.readFileSync(path.join(configDir, file), 'utf8')));
        }
    }
    if (!summaries.length) return null;
    summaries.sort((a, b) => (CONFIG_ORDER.indexOf(a.config) - CONFIG_ORDER.indexOf(b.config))
        || a.payloadBytes - b.payloadBytes || a.offeredRate - b.offeredRate);
    const categories = ['fs-sync-io', 'axios', 'express', 'node-http', 'streams-net', 'json', 'console-logging',
        'raft-engine', 'raft-log-store', 'raft-transport', 'state-machine', 'gc', 'instrumentation'];
    const lines = [
        `| profile | offered/s | achieved/s | busy % of wall | ${categories.join(' | ')} |`,
        `|---|---:|---:|---:|${categories.map(() => '---:').join('|')}|`,
    ];
    for (const s of summaries) {
        const byCategory = Object.fromEntries(s.categories.map((c) => [c.category, c.percentOfBusy]));
        lines.push(`| ${s.config} ${s.payloadBytes} B ${s.label} | ${fmtInt(s.offeredRate)} | ${fmtInt(s.trial.achievedPerSec)} | `
            + `${fmt(s.busyPercentOfWall, 1)} | ${categories.map((c) => fmt(byCategory[c] || 0, 1)).join(' | ')} |`);
    }
    lines.push('', 'Category columns are percent of *busy* (non-idle) sampled time on the leader.');
    return lines.join('\n');
}

// ── SVG saturation chart ────────────────────────────────────────────────────

const PALETTE = ['#1f6feb', '#d97706', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#6b7280'];

function saturationSvg(curves, payload) {
    const selected = curves.filter((c) => c.payloadBytes === payload && c.points.some((p) => p.phase === 'ladder'));
    if (!selected.length) return null;
    const width = 760;
    const height = 420;
    const margin = { left: 70, right: 200, top: 40, bottom: 56 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const allPoints = selected.flatMap((c) => c.points.filter((p) => p.phase === 'ladder'));
    const minX = Math.min(...allPoints.map((p) => p.rate));
    const maxX = Math.max(...allPoints.map((p) => p.rate));
    const ys = allPoints.map((p) => p.latencyAllMs.p99).filter((v) => v > 0);
    const minY = Math.max(0.1, Math.min(...ys) / 1.5);
    const maxY = Math.max(...ys) * 1.5;
    const lx = (v) => Math.log10(v);
    const x = (v) => margin.left + ((lx(v) - lx(minX)) / Math.max(1e-9, lx(maxX) - lx(minX))) * plotW;
    const y = (v) => margin.top + plotH - ((lx(v) - lx(minY)) / Math.max(1e-9, lx(maxY) - lx(minY))) * plotH;
    const parts = [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="12">`,
        `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
        `<text x="${margin.left}" y="22" font-size="14" font-weight="600" fill="#111827">p99 end-to-end latency vs offered load — ${payload} B writes, 3-replica CloudProof Raft (log-log)</text>`,
    ];
    const decades = [];
    for (let d = Math.floor(lx(minY)); d <= Math.ceil(lx(maxY)); d += 1) decades.push(10 ** d);
    for (const v of decades) {
        if (v < minY || v > maxY) continue;
        parts.push(`<line x1="${margin.left}" x2="${margin.left + plotW}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#e5e7eb"/>`);
        parts.push(`<text x="${margin.left - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" fill="#4b5563">${v >= 1 ? v : v.toFixed(1)} ms</text>`);
    }
    const xTicks = [...new Set(allPoints.map((p) => p.rate))].sort((a, b) => a - b);
    const shownTicks = xTicks.filter((_, i) => xTicks.length <= 10 || i % Math.ceil(xTicks.length / 10) === 0);
    for (const v of shownTicks) {
        parts.push(`<line x1="${x(v).toFixed(1)}" x2="${x(v).toFixed(1)}" y1="${margin.top}" y2="${margin.top + plotH}" stroke="#f3f4f6"/>`);
        parts.push(`<text x="${x(v).toFixed(1)}" y="${margin.top + plotH + 18}" text-anchor="middle" fill="#4b5563">${v >= 1000 ? `${v / 1000}k` : v}</text>`);
    }
    parts.push(`<rect x="${margin.left}" y="${margin.top}" width="${plotW}" height="${plotH}" fill="none" stroke="#9ca3af"/>`);
    parts.push(`<text x="${margin.left + plotW / 2}" y="${height - 12}" text-anchor="middle" fill="#111827">offered load (writes/s, open loop)</text>`);
    selected.forEach((curve, index) => {
        const color = PALETTE[index % PALETTE.length];
        const points = curve.points.filter((p) => p.phase === 'ladder').sort((a, b) => a.rate - b.rate);
        const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.rate).toFixed(1)},${y(Math.max(minY, p.latencyAllMs.p99)).toFixed(1)}`).join(' ');
        parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`);
        for (const p of points) {
            const cx = x(p.rate).toFixed(1);
            const cy = y(Math.max(minY, p.latencyAllMs.p99)).toFixed(1);
            parts.push(p.stable
                ? `<circle cx="${cx}" cy="${cy}" r="3.5" fill="${color}"/>`
                : `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#ffffff" stroke="${color}" stroke-width="1.5"/>`);
        }
        if (curve.knee.kneeRate) {
            const kp = points.find((p) => p.rate === curve.knee.kneeRate);
            if (kp) parts.push(`<circle cx="${x(kp.rate).toFixed(1)}" cy="${y(Math.max(minY, kp.latencyAllMs.p99)).toFixed(1)}" r="7" fill="none" stroke="${color}" stroke-width="1.5"/>`);
        }
        const ly = margin.top + 14 + index * 20;
        parts.push(`<line x1="${margin.left + plotW + 16}" x2="${margin.left + plotW + 36}" y1="${ly - 4}" y2="${ly - 4}" stroke="${color}" stroke-width="2"/>`);
        parts.push(`<text x="${margin.left + plotW + 42}" y="${ly}" fill="#111827">${CONFIG_LABEL[curve.config] || curve.config}</text>`);
    });
    const noteY = margin.top + 14 + selected.length * 20 + 10;
    parts.push(`<text x="${margin.left + plotW + 16}" y="${noteY}" fill="#4b5563">filled = stable, hollow =</text>`);
    parts.push(`<text x="${margin.left + plotW + 16}" y="${noteY + 15}" fill="#4b5563">unstable, ring = knee</text>`);
    parts.push(`<text x="${margin.left + plotW + 16}" y="${noteY + 30}" fill="#4b5563">p99 over all arrivals,</text>`);
    parts.push(`<text x="${margin.left + plotW + 16}" y="${noteY + 45}" fill="#4b5563">from intended send time</text>`);
    parts.push('</svg>');
    return `${parts.join('\n')}\n`;
}

function csvRows(curves) {
    const header = ['config', 'payload_bytes', 'phase', 'offered_per_s', 'repetitions', 'stable_votes',
        'achieved_per_s_mean', 'achieved_per_s_min', 'achieved_per_s_max', 'error_rate_mean',
        'p50_ms', 'p90_ms', 'p95_ms', 'p99_ms', 'p999_ms', 'max_ms',
        'leader_cpu_pct', 'leader_cpu_us_per_op', 'leader_elu', 'cluster_log_fsync_per_s', 'cluster_meta_saves_per_s',
        'leader_append_entries_per_s', 'entries_per_append', 'entries_per_fsync', 'replication_bytes_per_op', 'client_bytes_per_op'];
    const rows = [header.join(',')];
    for (const curve of curves) {
        for (const p of curve.points) {
            rows.push([curve.config, curve.payloadBytes, p.phase, p.rate, p.repetitions, p.stableVotes,
                p.achievedPerSec.mean, p.achievedPerSec.min, p.achievedPerSec.max, p.errorRate.mean,
                p.latencyAllMs.p50, p.latencyAllMs.p90, p.latencyAllMs.p95, p.latencyAllMs.p99, p.latencyAllMs.p999, p.latencyAllMs.max,
                p.leader.cpuPercentOfOneCore.mean, p.leader.cpuMicrosPerOp.mean, p.leader.eventLoopUtilization.mean,
                p.cluster.logFsyncsPerSec.mean, p.cluster.metaSavesPerSec.mean,
                p.leader.appendEntriesPerSec.mean, p.leader.entriesPerAppendMean.mean, p.leader.entriesPerFsyncMean.mean,
                p.cluster.replicationBytesPerOp.mean, p.cluster.clientBytesPerOp.mean]
                .map((v) => (v === null || v === undefined ? '' : v)).join(','));
        }
    }
    return `${rows.join('\n')}\n`;
}

function replaceGenerated(docText, blocks) {
    return docText.replace(/<!-- BEGIN GENERATED:([\w-]+) -->[\s\S]*?<!-- END GENERATED:\1 -->/g, (match, name) => {
        if (!(name in blocks)) return match;
        return `<!-- BEGIN GENERATED:${name} -->\n${blocks[name]}\n<!-- END GENERATED:${name} -->`;
    });
}

function main() {
    const options = parseArgs(process.argv.slice(2), DEFAULTS, { strings: ['root', 'doc'] });
    const root = path.resolve(options.root);
    const { curves, hashes } = loadCurves(root);
    const rows = comparisonRows(curves);
    const payloads = [...new Set(curves.map((c) => c.payloadBytes))].sort((a, b) => a - b);

    const blocks = {};
    blocks['knee-table'] = rows.length ? kneeTable(rows) : '_No sweeps recorded yet._';
    for (const payload of payloads) blocks[`comparison-${payload}`] = comparisonTable(rows, payload);
    for (const curve of curves) blocks[`curve-${curve.config}-${curve.payloadBytes}`] = curveTable(curve);
    const profiles = profileTable(root);
    if (profiles) blocks['profile-table'] = profiles;

    const svgFiles = [];
    for (const payload of payloads) {
        const svg = saturationSvg(curves, payload);
        if (!svg) continue;
        const file = path.join(root, `saturation-${payload}B.svg`);
        fs.writeFileSync(file, svg);
        svgFiles.push(path.basename(file));
    }

    const summary = {
        schema: 'cloudproof.raft-bench.summary/v1',
        generatedBy: 'tools/raft-bench-report.js',
        inputs: hashes,
        comparison: rows,
        curves: curves.map((c) => ({
            config: c.config,
            payloadBytes: c.payloadBytes,
            knee: c.knee,
            points: c.points.map((p) => ({
                phase: p.phase, rate: p.rate, repetitions: p.repetitions, stableVotes: p.stableVotes,
                achievedPerSec: p.achievedPerSec, errorRate: p.errorRate, latencyAllMs: p.latencyAllMs,
                p99AllMsPerRep: p.p99AllMsPerRep, leader: p.leader, followers: p.followers, cluster: p.cluster,
                generatorSaturated: p.generatorSaturated, leadershipChanged: p.leadershipChanged,
            })),
        })),
    };
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'summary.csv'), csvRows(curves));

    const report = ['# Phase IV-A generated benchmark report', '',
        '_Generated by `node tools/raft-bench-report.js` from the raw trial records. Do not edit by hand._', ''];
    report.push('## Saturation knees', '', blocks['knee-table'], '');
    for (const payload of payloads) report.push(`## Configuration comparison — ${payload} B`, '', blocks[`comparison-${payload}`], '');
    for (const file of svgFiles) report.push(`![${file}](${file})`, '');
    if (profiles) report.push('## CPU profiles (leader)', '', profiles, '');
    report.push('## Saturation curves', '');
    for (const curve of curves) report.push(blocks[`curve-${curve.config}-${curve.payloadBytes}`], '');
    report.push('## Input hashes', '', '| file | trials | sha256 |', '|---|---:|---|');
    for (const [file, info] of Object.entries(hashes)) report.push(`| ${file} | ${info.trials} | \`${info.sha256}\` |`);
    fs.writeFileSync(path.join(root, 'REPORT.md'), `${report.join('\n')}\n`);

    if (options.doc) {
        const docPath = path.resolve(options.doc);
        const text = fs.readFileSync(docPath, 'utf8');
        fs.writeFileSync(docPath, replaceGenerated(text, blocks));
    }
    process.stdout.write(`report: ${curves.length} curves, ${rows.length} comparison rows, ${svgFiles.length} charts -> ${path.relative(ROOT, root)}\n`);
}

if (require.main === module) main();

module.exports = { comparisonRows, replaceGenerated, saturationSvg, csvRows, loadCurves };
