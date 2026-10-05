#!/usr/bin/env node
'use strict';

/**
 * raft-bench-report.js — generates every Phase IV-A table from the recorded
 * artifacts. No benchmark number in the write-up is typed by hand.
 *
 *   node tools/raft-bench-report.js [--root artifacts/perf/phase-iv-a] [--doc CLOUDPROOF-PHASE-IV-A.md]
 *
 * Reads <root>/<sweep>/trials.jsonl for every sweep directory present (or
 * only those named by --sweeps), <root>/profiles/<config>/*.json, and
 * <root>/etcd/ if present. Writes, into --out (default <root>):
 *
 *   summary.json        canonical cross-config summary
 *   summary.csv         one row per (config, payload, phase, rate)
 *   trials.csv          one row per trial, with its disk-sentinel covariate
 *   saturation-<N>B.svg p99 vs offered load, one line per config
 *   REPORT.md           all generated tables
 *
 * and, with --doc, replaces every `<!-- BEGIN GENERATED:<name> -->` ...
 * `<!-- END GENERATED:<name> -->` block in that document with the table of
 * the same name.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseArgs } = require('../packages/raft-bench/cli');
const { readTrials, groupTrials, mean } = require('../packages/raft-bench/aggregate');
const { LogLinearHistogram } = require('../replica/perf-histogram');

const ROOT = path.join(__dirname, '..');
const CONFIG_ORDER = ['baseline', 'group-commit', 'pipeline-only', 'batch-only', 'group-batch', 'group-batch-pipeline',
    'optimized-http', 'optimized-binary', 'transport-only', 'etcd'];
const CONFIG_LABEL = {
    baseline: 'Baseline',
    'group-commit': 'Group commit',
    'pipeline-only': 'Pipeline only',
    'batch-only': 'Batch only',
    'group-batch': 'Group + batch',
    'group-batch-pipeline': 'Group + batch + pipeline',
    'optimized-http': 'Optimized HTTP',
    'optimized-binary': 'Optimized binary',
    'transport-only': 'Baseline + framed TCP only',
    etcd: 'etcd',
};
const REGIMES = ['fast', 'intermediate', 'slow'];

const DEFAULTS = {
    root: path.join(ROOT, 'artifacts', 'perf', 'phase-iv-a'),
    doc: null,
    sweeps: null,
    out: null,
    // Directory of CPU-profile summaries (<config>/*.json); default <root>/profiles.
    profiles: null,
};

const fmt = (value, digits = 1) => (value === null || value === undefined || !Number.isFinite(value)
    ? '—' : Number(value).toFixed(digits));
const fmtInt = (value) => (value === null || value === undefined || !Number.isFinite(value)
    ? '—' : Math.round(value).toLocaleString('en-US'));

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function loadCurves(root, sweeps = null) {
    const curves = [];
    const hashes = {};
    const allTrials = [];
    for (const entry of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
        if (!entry.isDirectory() || entry.name === 'profiles') continue;
        if (sweeps && !sweeps.includes(entry.name)) continue;
        const trialsFile = path.join(root, entry.name, 'trials.jsonl');
        if (!fs.existsSync(trialsFile)) continue;
        const trials = readTrials(trialsFile);
        hashes[`${entry.name}/trials.jsonl`] = { sha256: sha256File(trialsFile), trials: trials.length };
        for (const trial of trials) allTrials.push({ ...trial, directory: entry.name });
        for (const curve of groupTrials(trials)) curves.push({ ...curve, directory: entry.name });
    }
    curves.sort((a, b) => (CONFIG_ORDER.indexOf(a.config) - CONFIG_ORDER.indexOf(b.config))
        || a.payloadBytes - b.payloadBytes);
    return { curves, hashes, trials: allTrials };
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
            kneeStableVotes: atKnee ? `${atKnee.stableVotes}/${atKnee.repetitions}` : null,
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

function profileTable(root, profilesDir = null) {
    const dir = profilesDir || path.join(root, 'profiles');
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

/**
 * The Phase IV-A headline table: every configuration at one payload against
 * the baseline measured in the same sweep (never the historical baseline).
 * Speedup is the ratio of maximum stable throughput. "Knee" columns pool every
 * repetition at the knee rate (pre-registered), so a marginal knee shows its
 * stable votes; p99 at 0.8x knee is the separately measured fraction point.
 */
function headlineTable(rows, payload) {
    const base = rows.find((r) => r.config === 'baseline' && r.payloadBytes === payload);
    const lines = [
        '| profile | stable throughput (ops/s) | vs interleaved baseline | knee (offered/s, stable reps) | knee p99 ms | knee p99.9 ms | p99 @ 0.8x knee ms | CPU µs/op | fsync+meta / op | entries / fsync | AppendEntries / op | entries / AppendEntries |',
        '|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ];
    for (const row of rows.filter((r) => r.payloadBytes === payload)) {
        const k = row.atKnee || {};
        const speedup = base && base.maxStableThroughputPerSec && row.maxStableThroughputPerSec
            ? `${(row.maxStableThroughputPerSec / base.maxStableThroughputPerSec).toFixed(1)}x` : '—';
        lines.push(`| ${CONFIG_LABEL[row.config] || row.config} | ${fmtInt(row.maxStableThroughputPerSec)} | ${speedup} | `
            + `${fmtInt(row.kneeRate)} (${row.kneeStableVotes || '—'}) | ${fmt(row.p99AtKneeMs, 2)} | ${fmt(row.p999AtKneeMs, 2)} | `
            + `${fmt(row.p99At80Ms, 2)} | ${fmt(k.leaderCpuMicrosPerOp, 0)} | ${fmt(k.fsyncsPerOp, 3)} | ${fmt(k.entriesPerFsync, 1)} | `
            + `${fmt(k.rpcsPerOp, 3)} | ${fmt(k.entriesPerAppend, 1)} |`);
    }
    return lines.join('\n');
}

/** The pre-registered key comparison table (methodology amendment 1). */
function keyTable(rows, payload) {
    const lines = [
        '| configuration | stable throughput (ops/s) | p99 @ knee (ms) | fsync + meta per op | entries / AppendEntries | leader CPU % @ knee |',
        '|---|---:|---:|---:|---:|---:|',
    ];
    for (const row of rows.filter((r) => r.payloadBytes === payload)) {
        const k = row.atKnee || {};
        lines.push(`| ${CONFIG_LABEL[row.config] || row.config} | ${fmtInt(row.maxStableThroughputPerSec)} | ${fmt(row.p99AtKneeMs, 2)} | `
            + `${fmt(k.fsyncsPerOp, 3)} | ${fmt(k.entriesPerAppend, 1)} | ${fmt(k.leaderCpuPercent, 0)} |`);
    }
    return lines.join('\n');
}

/**
 * The matched etcd comparison (methodology amendment 4): every curve of a
 * sweep that contains etcd, at one payload, read at its knee. Cluster CPU and
 * durable syncs per op are means over the knee trials' own records
 * (server.clusterCpuMicrosPerOp, server.clusterDurableSyncsPerOp). For
 * CloudProof "log" is its log fsync and "state" its metadata save; for etcd
 * they are the WAL fsync and the bbolt backend commit (other syncs: snapshot
 * fsyncs, counted in the total).
 */
function matchedRows(curves, trials, payload) {
    const selected = curves.filter((c) => c.payloadBytes === payload);
    const etcd = selected.find((c) => c.config === 'etcd');
    if (!etcd) return [];
    return selected.map((curve) => {
        const at = (fraction) => pointAt(curve, fraction);
        const knee = at(1);
        const kneeTrials = knee ? trials.filter((t) => t.directory === curve.directory && t.config === curve.config
            && t.workload.payloadBytes === payload && (t.phase || 'ladder') === 'ladder' && t.load.offeredRate === knee.rate) : [];
        const meanOf = (fn) => mean(kneeTrials.map(fn).filter(Number.isFinite));
        const achieved = knee ? knee.achievedPerSec.mean : null;
        const perOp = (perSec) => (achieved && Number.isFinite(perSec) ? perSec / achieved : null);
        return {
            config: curve.config,
            system: curve.config === 'etcd' ? 'etcd' : 'cloudproof',
            kneeRate: curve.knee.kneeRate,
            kneeStableVotes: knee ? `${knee.stableVotes}/${knee.repetitions}` : null,
            maxStableThroughputPerSec: curve.knee.maxStableThroughputPerSec,
            vsEtcd: etcd.knee.maxStableThroughputPerSec && curve.knee.maxStableThroughputPerSec
                ? curve.knee.maxStableThroughputPerSec / etcd.knee.maxStableThroughputPerSec : null,
            p99At50Ms: at(0.5) ? at(0.5).latencyAllMs.p99 : null,
            p99At80Ms: at(0.8) ? at(0.8).latencyAllMs.p99 : null,
            p99AtKneeMs: knee ? knee.latencyAllMs.p99 : null,
            leaderCpuPercent: knee ? knee.leader.cpuPercentOfOneCore.mean : null,
            leaderCpuMicrosPerOp: knee ? knee.leader.cpuMicrosPerOp.mean : null,
            clusterCpuMicrosPerOp: meanOf((t) => t.server.clusterCpuMicrosPerOp),
            durableSyncsPerOp: meanOf((t) => t.server.clusterDurableSyncsPerOp),
            logSyncsPerOp: knee ? perOp(knee.cluster.logFsyncsPerSec.mean) : null,
            stateSyncsPerOp: knee ? perOp(knee.cluster.metaSavesPerSec.mean) : null,
            entriesPerLeaderFsync: knee ? knee.leader.entriesPerFsyncMean.mean : null,
            replicationBytesPerOp: knee ? knee.cluster.replicationBytesPerOp.mean : null,
            kneeTrials: kneeTrials.length,
        };
    });
}

function matchedTable(rows) {
    const lines = [
        '| system | stable throughput (ops/s) | vs etcd | knee (offered/s, stable reps) | p99 @ 0.5x ms | p99 @ 0.8x ms | p99 @ knee ms | leader CPU % | leader CPU µs/op | cluster CPU µs/op | durable syncs / op | log·WAL fsyncs / op | meta·bbolt syncs / op | entries / leader fsync | repl bytes / op |',
        '|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ];
    for (const row of rows) {
        lines.push(`| ${CONFIG_LABEL[row.config] || row.config} | ${fmtInt(row.maxStableThroughputPerSec)} | `
            + `${row.vsEtcd === null ? '—' : `${row.vsEtcd.toFixed(2)}x`} | ${fmtInt(row.kneeRate)} (${row.kneeStableVotes || '—'}) | `
            + `${fmt(row.p99At50Ms, 2)} | ${fmt(row.p99At80Ms, 2)} | ${fmt(row.p99AtKneeMs, 2)} | ${fmt(row.leaderCpuPercent, 0)} | `
            + `${fmt(row.leaderCpuMicrosPerOp, 0)} | ${fmt(row.clusterCpuMicrosPerOp, 0)} | ${fmt(row.durableSyncsPerOp, 3)} | `
            + `${fmt(row.logSyncsPerOp, 3)} | ${fmt(row.stateSyncsPerOp, 3)} | ${fmt(row.entriesPerLeaderFsync, 1)} | `
            + `${fmtInt(row.replicationBytesPerOp)} |`);
    }
    lines.push('', 'CloudProof: log fsync and metadata save. etcd: WAL fsync and bbolt backend commit; durable syncs also '
        + 'count etcd\'s snapshot fsyncs. etcd replication bytes are raft message bytes on the followers\' peer links, '
        + 'CloudProof\'s are TCP payload bytes on the followers\' sockets. All values at each curve\'s own knee.');
    return lines.join('\n');
}

function pooledP99(trials) {
    if (!trials.length) return null;
    const merged = new LogLinearHistogram();
    for (const trial of trials) merged.merge(LogLinearHistogram.fromJSON(trial.rawHistograms.latencyAll));
    return merged.summary(1000).p99;
}

/**
 * Regime sensitivity (methodology amendment 1): per configuration and disk
 * regime, the knee computed from only that regime's trials, with gaps and
 * trial counts, plus throughput and pooled p99 at the overall knee.
 */
function regimeRows(trials, curves) {
    const rows = [];
    for (const curve of curves) {
        const own = trials.filter((t) => t.config === curve.config && t.workload.payloadBytes === curve.payloadBytes
            && t.directory === curve.directory && (t.phase || 'ladder') === 'ladder');
        for (const regime of REGIMES) {
            const inRegime = own.filter((t) => t.diskSentinel && t.diskSentinel.regime === regime);
            if (!inRegime.length) continue;
            const rates = [...new Set(own.map((t) => t.load.offeredRate))].sort((a, b) => a - b);
            let knee = null;
            const gaps = [];
            for (const rate of rates) {
                const atRate = inRegime.filter((t) => t.load.offeredRate === rate);
                if (!atRate.length) { gaps.push(rate); continue; }
                const stable = atRate.filter((t) => t.stability.stable).length * 2 > atRate.length;
                if (!stable) break;
                knee = rate;
            }
            const atKnee = knee === null ? [] : inRegime.filter((t) => t.load.offeredRate === knee);
            const atOverallKnee = curve.knee.kneeRate === null ? []
                : inRegime.filter((t) => t.load.offeredRate === curve.knee.kneeRate);
            rows.push({
                config: curve.config,
                payloadBytes: curve.payloadBytes,
                regime,
                trials: inRegime.length,
                kneeRate: knee,
                gapsBelowKnee: knee === null ? [] : gaps.filter((rate) => rate < knee),
                achievedAtRegimeKnee: atKnee.length ? mean(atKnee.map((t) => t.achievedPerSec)) : null,
                trialsAtRegimeKnee: atKnee.length,
                overallKneeRate: curve.knee.kneeRate,
                achievedAtOverallKnee: atOverallKnee.length ? mean(atOverallKnee.map((t) => t.achievedPerSec)) : null,
                p99AtOverallKneeMs: pooledP99(atOverallKnee),
                trialsAtOverallKnee: atOverallKnee.length,
                medianSentinelFsyncMs: median(inRegime.map((t) => t.diskSentinel.medianFsyncMs)),
            });
        }
    }
    return rows;
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function regimeTable(rows, payload) {
    const lines = [
        '| configuration | disk regime | trials | sentinel median fsync ms | regime knee (offered/s) | achieved @ regime knee | gaps below knee | achieved @ overall knee (n) | p99 @ overall knee ms |',
        '|---|---|---:|---:|---:|---:|---|---:|---:|',
    ];
    for (const row of rows.filter((r) => r.payloadBytes === payload)) {
        lines.push(`| ${CONFIG_LABEL[row.config] || row.config} | ${row.regime} | ${row.trials} | ${fmt(row.medianSentinelFsyncMs, 2)} | `
            + `${fmtInt(row.kneeRate)} | ${fmtInt(row.achievedAtRegimeKnee)} (${row.trialsAtRegimeKnee}) | `
            + `${row.gapsBelowKnee.length ? row.gapsBelowKnee.join(', ') : '—'} | `
            + `${fmtInt(row.achievedAtOverallKnee)} (${row.trialsAtOverallKnee}) | ${fmt(row.p99AtOverallKneeMs, 2)} |`);
    }
    return lines.join('\n');
}

function trialsCsv(trials) {
    const header = ['directory', 'config', 'payload_bytes', 'phase', 'offered_rate', 'repetition', 'order_round', 'order_position',
        'started_at', 'sentinel_median_fsync_ms', 'sentinel_p95_fsync_ms', 'sentinel_p99_fsync_ms', 'sentinel_samples',
        'regime', 'regime_after', 'achieved_per_sec', 'error_rate', 'p50_ms', 'p99_ms', 'stable', 'leader_cpu_pct'];
    const rows = [header.join(',')];
    for (const t of trials) {
        const d = t.diskSentinel || {};
        const o = t.order || {};
        rows.push([t.directory, t.config, t.workload.payloadBytes, t.phase || 'ladder', t.load.offeredRate, t.repetition,
            o.round, o.position, t.startedAt, d.medianFsyncMs, d.p95FsyncMs, d.p99FsyncMs, d.sampleCount, d.regime, d.afterRegime,
            t.achievedPerSec, t.errorRate, t.latencyAllMs.p50, t.latencyAllMs.p99, t.stability.stable,
            t.server && t.server.leader ? t.server.leader.cpuPercentOfOneCore : null]
            .map((v) => (v === null || v === undefined ? '' : v)).join(','));
    }
    return `${rows.join('\n')}\n`;
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
        `<text x="${margin.left}" y="22" font-size="14" font-weight="600" fill="#111827">p99 end-to-end latency vs offered load — ${payload} B writes, `
            + `${selected.some((c) => c.config === 'etcd') ? '3-member CloudProof and etcd clusters' : '3-replica CloudProof Raft'} (log-log)</text>`,
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
    const options = parseArgs(process.argv.slice(2), DEFAULTS, {
        strings: ['root', 'doc', 'out', 'profiles'], lists: { sweeps: String },
    });
    const root = path.resolve(options.root);
    const outDir = options.out ? path.resolve(options.out) : root;
    fs.mkdirSync(outDir, { recursive: true });
    const { curves, hashes, trials } = loadCurves(root, options.sweeps);
    const regimes = regimeRows(trials, curves);
    const rows = comparisonRows(curves);
    const payloads = [...new Set(curves.map((c) => c.payloadBytes))].sort((a, b) => a - b);

    const blocks = {};
    blocks['knee-table'] = rows.length ? kneeTable(rows) : '_No sweeps recorded yet._';
    for (const payload of payloads) blocks[`comparison-${payload}`] = comparisonTable(rows, payload);
    for (const payload of payloads) blocks[`key-table-${payload}`] = keyTable(rows, payload);
    for (const payload of payloads) blocks[`headline-${payload}`] = headlineTable(rows, payload);
    const regimePayloads = [...new Set(regimes.map((r) => r.payloadBytes))];
    for (const payload of regimePayloads) blocks[`regimes-${payload}`] = regimeTable(regimes, payload);
    for (const curve of curves) blocks[`curve-${curve.config}-${curve.payloadBytes}`] = curveTable(curve);
    const profiles = profileTable(root, options.profiles ? path.resolve(options.profiles) : null);
    if (profiles) blocks['profile-table'] = profiles;
    const matched = Object.fromEntries(payloads.map((payload) => [payload, matchedRows(curves, trials, payload)])
        .filter(([, list]) => list.length));
    for (const [payload, list] of Object.entries(matched)) blocks[`etcd-matched-${payload}`] = matchedTable(list);

    const svgFiles = [];
    for (const payload of payloads) {
        const svg = saturationSvg(curves, payload);
        if (!svg) continue;
        const file = path.join(outDir, `saturation-${payload}B.svg`);
        fs.writeFileSync(file, svg);
        svgFiles.push(path.basename(file));
    }

    const summary = {
        schema: 'cloudproof.raft-bench.summary/v1',
        generatedBy: 'tools/raft-bench-report.js',
        inputs: hashes,
        comparison: rows,
        ...(Object.keys(matched).length ? { etcdMatched: matched } : {}),
        regimeSensitivity: regimes,
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
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, 'summary.csv'), csvRows(curves));
    if (trials.some((t) => t.diskSentinel)) fs.writeFileSync(path.join(outDir, 'trials.csv'), trialsCsv(trials));

    const report = ['# Phase IV-A generated benchmark report', '',
        '_Generated by `node tools/raft-bench-report.js` from the raw trial records. Do not edit by hand._', ''];
    report.push('## Saturation knees', '', blocks['knee-table'], '');
    for (const payload of Object.keys(matched)) {
        report.push(`## Matched etcd comparison — ${payload} B`, '', blocks[`etcd-matched-${payload}`], '');
    }
    for (const payload of payloads) report.push(`## Headline — ${payload} B (speedup vs the interleaved baseline of this sweep)`, '', blocks[`headline-${payload}`], '');
    for (const payload of payloads) report.push(`## Key comparison — ${payload} B`, '', blocks[`key-table-${payload}`], '');
    for (const payload of regimePayloads) {
        report.push(`## Disk-regime sensitivity — ${payload} B`, '',
            'Each trial is assigned the fsync regime of the disk sentinel sampled immediately before it '
            + '(fast < 0.5 ms <= intermediate < 1.5 ms <= slow, median of 300 bare append+fsync). No trial is excluded '
            + 'from the overall results above; this view regroups the same trials.', '', blocks[`regimes-${payload}`], '');
    }
    for (const payload of payloads) report.push(`## Configuration comparison — ${payload} B`, '', blocks[`comparison-${payload}`], '');
    for (const file of svgFiles) report.push(`![${file}](${file})`, '');
    if (profiles) report.push('## CPU profiles (leader)', '', profiles, '');
    report.push('## Saturation curves', '');
    for (const curve of curves) report.push(blocks[`curve-${curve.config}-${curve.payloadBytes}`], '');
    report.push('## Input hashes', '', '| file | trials | sha256 |', '|---|---:|---|');
    for (const [file, info] of Object.entries(hashes)) report.push(`| ${file} | ${info.trials} | \`${info.sha256}\` |`);
    fs.writeFileSync(path.join(outDir, 'REPORT.md'), `${report.join('\n')}\n`);

    if (options.doc) {
        const docPath = path.resolve(options.doc);
        const text = fs.readFileSync(docPath, 'utf8');
        fs.writeFileSync(docPath, replaceGenerated(text, blocks));
    }
    process.stdout.write(`report: ${curves.length} curves, ${rows.length} comparison rows, ${svgFiles.length} charts -> ${path.relative(ROOT, outDir)}\n`);
}

if (require.main === module) main();

module.exports = {
    comparisonRows, replaceGenerated, saturationSvg, csvRows, loadCurves, regimeRows, keyTable, headlineTable, trialsCsv,
    matchedRows, matchedTable,
};
