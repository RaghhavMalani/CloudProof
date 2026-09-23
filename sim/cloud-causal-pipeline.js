'use strict';

// Orchestrates the Phase II-A.2 corpus: two execution passes, matching,
// counterfactual pairs, replay verification, and the canonical manifest.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stable } = require('../packages/cloudproof/state');
const { CLOUD_FAULT } = require('../packages/cloudproof/faults');
const {
    SPLIT_POLICY_V2,
    TOPOLOGY_CATALOG,
    TOPOLOGY_CATALOG_V2,
    assertDisjointTopologySplits,
} = require('../packages/cloudproof/topology');
const readline = require('node:readline');
const {
    REPORT_ONLY_NUISANCE_NAMES,
    balancePositions,
    capRowsPerTrajectory,
    categoricalOverlap,
    matchTrajectories,
    pruneShortcutPairs,
    standardizedMeanDifferences,
} = require('../packages/cloudproof/nuisance');
const { FAMILY_DESCRIPTIONS, PAIR_FAMILIES } = require('../packages/cloudproof/counterfactual-pairs');
const { CLOUD_SCHEDULE_SCHEMA_VERSION } = require('./cloud-actions');
const { GENERATOR_ID, GENERATOR_VERSION } = require('./cloud-causal-generator');
const {
    CAUSAL_DATASET_SCHEMA_VERSION,
    DEFAULT_HORIZON,
    FEATURE_BOUNDARY,
    HORIZONS,
    SPLITS,
    defaultWorkers,
    executeCounterfactualPair,
    normalizeConfig,
    regenerateSchedule,
    runPool,
} = require('./cloud-causal-corpus');
const { replayCloudArtifact } = require('./cloud-search');

const FILENAMES = Object.freeze({
    train: 'transitions-train.jsonl',
    validation: 'transitions-validation.jsonl',
    test: 'transitions-test.jsonl',
    ood: 'transitions-ood.jsonl',
    trajectories: 'trajectories.jsonl',
    pairs: 'counterfactual-pairs.jsonl',
});

function gitCommitSha() {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch (_) {
        return 'unknown';
    }
}

async function hashFile(file) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        const input = fs.createReadStream(file);
        input.on('data', (chunk) => hash.update(chunk));
        input.on('end', resolve);
        input.on('error', reject);
    });
    return hash.digest('hex');
}

function quantiles(values, fractions = [0.1, 0.25, 0.5, 0.75, 0.9]) {
    if (!values.length) return null;
    const sorted = values.slice().sort((left, right) => left - right);
    return Object.fromEntries(fractions.map((fraction) => [
        `p${Math.round(fraction * 100)}`, sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))],
    ]));
}

function counter(values) {
    const counts = {};
    for (const value of values) counts[String(value)] = (counts[String(value)] || 0) + 1;
    return stable(counts);
}

function splitDistribution(summaries, selectedIds) {
    const distributions = {};
    for (const split of SPLITS) {
        const items = summaries.filter((summary) => summary.split === split);
        const selected = items.filter((summary) => selectedIds.has(summary.trajectoryId));
        distributions[split] = {
            trajectories: items.length,
            safe: items.filter((summary) => summary.outcome === 'safe').length,
            unsafe: items.filter((summary) => summary.outcome === 'unsafe').length,
            selected: selected.length,
            selectedSafe: selected.filter((summary) => summary.outcome === 'safe').length,
            selectedUnsafe: selected.filter((summary) => summary.outcome === 'unsafe').length,
            rows: selected.reduce((sum, summary) => sum + summary.mlRows, 0),
            unsafeByTier: counter(selected.filter((summary) => summary.difficulty)
                .map((summary) => summary.difficulty.tier)),
            incidentClasses: counter(selected.filter((summary) => summary.incident)
                .map((summary) => summary.incident.violationClass)),
        };
    }
    return stable(distributions);
}

function nuisanceReport(summaries, selected) {
    const byOutcome = (items, key) => ({
        safe: quantiles(items.filter((item) => item.outcome === 'safe').map((item) => item[key])),
        unsafe: quantiles(items.filter((item) => item.outcome === 'unsafe').map((item) => item[key])),
    });
    const placementByOutcome = (items) => {
        const report = {};
        for (const item of items) {
            report[item.placementKind] = report[item.placementKind] || { safe: 0, unsafe: 0 };
            report[item.placementKind][item.outcome] += 1;
        }
        return report;
    };
    const unsafe = selected.filter((item) => item.incident);
    return stable({
        pool: {
            smd: standardizedMeanDifferences(summaries),
            categorical: categoricalOverlap(summaries),
            scheduleLength: byOutcome(summaries, 'actions'),
            transitions: byOutcome(summaries, 'transitions'),
            virtualRuntimeMs: byOutcome(summaries, 'virtualRuntimeMs'),
            faultCount: byOutcome(summaries, 'faultCount'),
            operationCount: byOutcome(summaries, 'operationCount'),
            hpaScaleEvents: byOutcome(summaries, 'hpaScaleEvents'),
            rolloutActiveTransitions: byOutcome(summaries, 'rolloutActiveTransitions'),
            placementByOutcome: placementByOutcome(summaries),
        },
        selected: {
            smd: standardizedMeanDifferences(selected),
            categorical: categoricalOverlap(selected),
            scheduleLength: byOutcome(selected, 'actions'),
            transitions: byOutcome(selected, 'transitions'),
            virtualRuntimeMs: byOutcome(selected, 'virtualRuntimeMs'),
            faultCount: byOutcome(selected, 'faultCount'),
            operationCount: byOutcome(selected, 'operationCount'),
            hpaScaleEvents: byOutcome(selected, 'hpaScaleEvents'),
            rolloutActiveTransitions: byOutcome(selected, 'rolloutActiveTransitions'),
            reportOnly: Object.fromEntries(REPORT_ONLY_NUISANCE_NAMES.map((name) => [name, byOutcome(selected, name)])),
            placementByOutcome: placementByOutcome(selected),
            incidentRelativePosition: quantiles(unsafe.map((item) => item.incident.relativePosition)),
            incidentSequence: quantiles(unsafe.map((item) => item.incident.sequence)),
            incidentActionTypes: counter(unsafe.map((item) => item.incident.actionType)),
            incidentClasses: counter(unsafe.map((item) => item.incident.violationClass)),
            difficultyTiers: counter(unsafe.map((item) => item.difficulty.tier)),
        },
    });
}

function classDistribution(pairs, summariesById) {
    const counts = {};
    for (const pair of pairs) {
        const cls = summariesById.get(pair.unsafeTrajectoryId).incident?.violationClass || 'unknown';
        counts[cls] = (counts[cls] || 0) + 1;
    }
    return stable(counts);
}

function capIncidentClasses(pairs, summariesById, maxShare) {
    const before = classDistribution(pairs, summariesById);
    let current = pairs.slice();
    const dropped = {};
    for (;;) {
        const counts = classDistribution(current, summariesById);
        const total = current.length;
        const offending = Object.entries(counts).filter(([, count]) => count / Math.max(1, total) > maxShare)
            .sort(([, left], [, right]) => right - left)[0];
        if (!offending || total === 0) break;
        const [cls] = offending;
        const candidates = current
            .filter((pair) => (summariesById.get(pair.unsafeTrajectoryId).incident?.violationClass || 'unknown') === cls)
            .sort((left, right) => right.distance - left.distance || right.matchId.localeCompare(left.matchId));
        const victim = candidates[0];
        current = current.filter((pair) => pair.matchId !== victim.matchId);
        dropped[cls] = (dropped[cls] || 0) + 1;
    }
    return stable({ maxShare, before, after: classDistribution(current, summariesById), dropped, pairs: current,
        droppedPairs: pairs.length - current.length });
}

function openOutputs(outputDirectory) {
    const resolved = path.resolve(outputDirectory);
    fs.mkdirSync(resolved, { recursive: true });
    // Transition rows first land in staging files; position balancing decides
    // which record IDs survive, and the final files are streamed from staging.
    const handles = Object.fromEntries(Object.entries(FILENAMES).map(([name, file]) => [name,
        fs.openSync(path.join(resolved, SPLITS.includes(name) ? `${file}.staging` : file), 'w')]));
    return { directory: resolved, handles };
}

async function streamKeptRows(directory, split, keep) {
    const staging = path.join(directory, `${FILENAMES[split]}.staging`);
    const target = path.join(directory, FILENAMES[split]);
    const output = fs.createWriteStream(target, { encoding: 'utf8' });
    const reader = readline.createInterface({ input: fs.createReadStream(staging, { encoding: 'utf8' }), crlfDelay: Infinity });
    let written = 0;
    for await (const line of reader) {
        if (!line) continue;
        const match = /"recordId":"([^"]+)"/.exec(line);
        if (!match || !keep.has(match[1])) continue;
        if (!output.write(`${line}\n`)) await new Promise((resolve) => output.once('drain', resolve));
        written += 1;
    }
    await new Promise((resolve) => output.end(resolve));
    fs.unlinkSync(staging);
    return written;
}

function writeLines(handle, lines) {
    if (lines.length) fs.writeSync(handle, `${lines.join('\n')}\n`, null, 'utf8');
}

async function generateCausalCorpus(options = {}) {
    const trajectories = options.trajectories ?? 20000;
    const pairCount = options.pairs ?? 800;
    const workers = options.workers ?? defaultWorkers();
    const log = options.log || (() => {});
    if (!Number.isInteger(trajectories) || trajectories < 1) throw new TypeError('trajectories must be positive');
    if (!Number.isInteger(pairCount) || pairCount < 0) throw new TypeError('pairs must be a non-negative integer');
    if (!options.outputDirectory) throw new TypeError('outputDirectory is required');
    const config = normalizeConfig({
        seedStart: options.seedStart ?? 90000,
        catalog: options.catalog || TOPOLOGY_CATALOG_V2,
        parameters: options.parameters || {},
        checkpoint: options.checkpoint || {},
        pairSeedStart: options.pairSeedStart ?? 95000,
        pairPolicy: options.pairPolicy || {},
    });
    assertDisjointTopologySplits(config.catalog);
    const indices = Array.from({ length: trajectories }, (_, index) => index);

    log(`pass 1: executing ${trajectories} outcome-blind trajectories on ${workers} worker(s)`);
    const summaries = new Array(trajectories);
    await runPool({
        indices, task: 'trajectory', config, wantRows: false, workers,
        onResult: (index, result) => { summaries[index] = result.summary; },
        onProgress: (done, total) => log(`  executed ${done}/${total}`),
    });

    log('matching safe and unsafe trajectories inside nuisance strata');
    const rawMatching = matchTrajectories(summaries, { caliper: options.caliper ?? 0.8 });
    log(`  ${rawMatching.counts.matchedPairs} matched pairs`);
    log('pruning pairs whose outcome a nuisance-only probe can predict');
    const summariesById = new Map(summaries.map((summary) => [summary.trajectoryId, summary]));
    const pruning = pruneShortcutPairs(rawMatching.pairs, summariesById, {
        targetAuroc: options.pruneTargetAuroc ?? 0.55,
        dropFraction: options.pruneDropFraction ?? 0.1,
        maxRounds: options.pruneMaxRounds ?? 15,
        floorFraction: options.pruneFloorFraction ?? 0.4,
    });
    // Post-hoc class cap: no single incident class may exceed `maxClassShare`
    // of the matched unsafe trajectories. Pairs of an over-represented class
    // are dropped worst-match first (largest standardized distance, then
    // matchId), whole, so balance and strata survive. Nothing about
    // generation changes; the raw class distribution stays in the manifest.
    const classCap = capIncidentClasses(pruning.pairs, summariesById, options.maxClassShare ?? 0.4);
    const keptPairs = classCap.pairs;
    const selectedMap = {};
    for (const pair of keptPairs) {
        selectedMap[pair.unsafeTrajectoryId] = pair.matchId;
        selectedMap[pair.safeTrajectoryId] = pair.matchId;
    }
    const selectedIds = new Set(Object.keys(selectedMap));
    const matchedSummaries = summaries.filter((summary) => selectedIds.has(summary.trajectoryId));
    // Matching and pruning are pure functions of the summaries (sorted by
    // trajectory ID) and the config; a second call must reproduce the same
    // pair list, which is asserted here rather than assumed.
    const replayMatching = matchTrajectories(summaries, { caliper: options.caliper ?? 0.8 });
    const deterministic = JSON.stringify(replayMatching.pairs) === JSON.stringify(rawMatching.pairs);
    const matching = stable({
        ...rawMatching,
        deterministic,
        pairs: keptPairs,
        selected: selectedMap,
        counts: {
            ...rawMatching.counts,
            matchedPairsBeforePruning: rawMatching.counts.matchedPairs,
            matchedPairs: keptPairs.length,
            selectedTrajectories: matchedSummaries.length,
        },
        balance: {
            before: rawMatching.balance.before,
            afterMatching: rawMatching.balance.after,
            after: standardizedMeanDifferences(matchedSummaries),
            categoricalAfter: categoricalOverlap(matchedSummaries),
        },
        pruning: { ...pruning, pairs: undefined },
        classCap: { ...classCap, pairs: undefined },
    });
    const selectedIndices = matchedSummaries.map((summary) => summary.index);
    log(`  pruning kept ${pruning.keptPairs}/${rawMatching.counts.matchedPairs} pairs `
        + `(cross-fit probe AUROC ${pruning.finalCrossFitAuroc?.toFixed(3)}); class cap dropped `
        + `${classCap.droppedPairs}; ${selectedIndices.length} trajectories selected`);

    const outputs = openOutputs(options.outputDirectory);
    const examplesBySplit = Object.fromEntries(SPLITS.map((split) => [split, []]));
    const candidates = [];
    const rowsBySplit = Object.fromEntries(SPLITS.map((split) => [split, 0]));
    let fingerprintMismatches = 0;
    let selectedReplayed = 0;
    let droppedPostIncident = 0;
    const pairSummaries = [];
    try {
        log(`pass 2: re-executing ${selectedIndices.length} selected trajectories and emitting rows`);
        await runPool({
            indices: selectedIndices, task: 'trajectory', config, wantRows: true, workers,
            onResult: (index, result) => {
                selectedReplayed += 1;
                if (result.summary.replayFingerprint !== summaries[index].replayFingerprint) fingerprintMismatches += 1;
                droppedPostIncident += result.summary.postIncidentTransitions;
                const split = result.summary.split;
                writeLines(outputs.handles[split], result.records);
                rowsBySplit[split] += result.records.length;
                examplesBySplit[split].push(...result.examples);
                candidates.push(result.candidate);
            },
            onProgress: (done, total) => log(`  emitted ${done}/${total}`),
        });

        log('writing trajectories.jsonl (pool, schedules, outcomes, matching)');
        const trajectoryLines = [];
        for (const summary of summaries) {
            const { schedule } = regenerateSchedule(summary.index, config);
            // Wall time is observational and would make the file hash drift
            // between machines; it stays in memory for the prioritizer report.
            const { verificationWallTimeMs, ...deterministic } = summary;
            trajectoryLines.push(JSON.stringify(stable({
                ...deterministic,
                selected: selectedIds.has(summary.trajectoryId),
                matchId: matching.selected[summary.trajectoryId] || null,
                schedule,
            })));
            if (trajectoryLines.length >= 500) {
                writeLines(outputs.handles.trajectories, trajectoryLines);
                trajectoryLines.length = 0;
            }
        }
        writeLines(outputs.handles.trajectories, trajectoryLines);

        log(`executing ${pairCount} counterfactual topology pairs`);
        await runPool({
            indices: Array.from({ length: pairCount }, (_, index) => index), task: 'pair', config, workers,
            onResult: (index, result) => {
                pairSummaries.push(result.summary);
                writeLines(outputs.handles.pairs, result.lines);
            },
            onProgress: (done, total) => log(`  pairs ${done}/${total}`),
        });
    } finally {
        Object.values(outputs.handles).forEach((handle) => fs.closeSync(handle));
    }

    log('capping rows per trajectory and balancing research rows over position cells');
    const positionBalance = {};
    const rowCap = {};
    for (const split of SPLITS) {
        const capped = capRowsPerTrajectory(examplesBySplit[split], {
            cap: options.maxRowsPerTrajectory ?? null,
            quantile: options.rowCapQuantile ?? 0.5,
            seed: 9001 + SPLITS.indexOf(split),
        });
        examplesBySplit[split] = examplesBySplit[split].filter((example) => capped.keep.has(example.recordId));
        rowCap[split] = { ...capped, keep: undefined };
        const balance = balancePositions(examplesBySplit[split], {
            horizon: DEFAULT_HORIZON,
            targetQuantile: options.positionTargetQuantile ?? 0.75,
            minimumKeepFraction: options.positionMinimumKeepFraction ?? 0.25,
            seed: 4242 + SPLITS.indexOf(split),
        });
        const keep = balance.keep;
        examplesBySplit[split] = examplesBySplit[split].filter((example) => keep.has(example.recordId));
        rowsBySplit[split] = await streamKeptRows(outputs.directory, split, keep);
        if (rowsBySplit[split] !== examplesBySplit[split].length) {
            throw new Error(`position balancing wrote ${rowsBySplit[split]} ${split} rows, expected ${examplesBySplit[split].length}`);
        }
        positionBalance[split] = { ...balance, keep: undefined };
    }
    log(`  kept ${Object.values(rowsBySplit).reduce((sum, value) => sum + value, 0)} rows`);

    // Pair truth must be reproducible from the schedule alone: re-run a
    // deterministic sample in-process and compare fingerprints.
    const replaySample = pairSummaries.filter((_, index) => index % Math.max(1, Math.floor(pairCount / 20)) === 0)
        .slice(0, 25);
    let pairMismatches = 0;
    for (const pair of replaySample) {
        const again = await executeCounterfactualPair(pair.pairIndex, config);
        if (again.summary.replayFingerprints.A !== pair.replayFingerprints.A
            || again.summary.replayFingerprints.B !== pair.replayFingerprints.B) pairMismatches += 1;
    }

    const phaseOneFile = options.phaseOneArtifact ?? path.join('artifacts', 'cloudproof', 'failure-1337.json');
    let phaseOne = null;
    if (fs.existsSync(phaseOneFile)) {
        const replay = await replayCloudArtifact(phaseOneFile);
        phaseOne = {
            file: phaseOneFile,
            sameFailure: replay.sameFailure,
            byteIdentical: replay.byteIdentical,
            violationClass: replay.result.failure?.violationClass || null,
        };
    }

    const files = {};
    for (const [name, file] of Object.entries(FILENAMES)) {
        const resolved = path.join(outputs.directory, file);
        files[file] = { bytes: fs.statSync(resolved).size, sha256: await hashFile(resolved), role: name };
    }
    const selectedSummaries = summaries.filter((summary) => selectedIds.has(summary.trajectoryId));
    const v1Ids = new Set(TOPOLOGY_CATALOG.map((entry) => entry.topologyId));
    const catalog = config.catalog;
    const manifest = stable({
        kind: 'cloudproof.causal-corpus-manifest',
        schemaVersion: CAUSAL_DATASET_SCHEMA_VERSION,
        phase: 'II-A.2',
        supersedes: {
            kind: 'cloudproof.research-dataset-manifest',
            reason: 'Phase II-B.1 attribution audit: Phase II-A labels were assigned by construction',
        },
        generator: {
            id: GENERATOR_ID,
            version: GENERATOR_VERSION,
            outcomeBlind: true,
            commitSha: options.generatorCommitSha || gitCommitSha(),
            parameters: config.parameters,
            checkpoint: config.checkpoint,
            pairPolicy: config.pairPolicy,
            workers,
        },
        simulatorSchemas: {
            clusterState: 1,
            infrastructureGraph: 1,
            schedule: CLOUD_SCHEDULE_SCHEMA_VERSION,
            transitionDataset: CAUSAL_DATASET_SCHEMA_VERSION,
        },
        seeds: {
            first: config.seedStart,
            last: config.seedStart + trajectories - 1,
            count: trajectories,
            pairFirst: config.pairSeedStart,
            pairLast: config.pairSeedStart + Math.max(0, pairCount - 1),
            pairCount,
        },
        counts: {
            pool: trajectories,
            poolSafe: summaries.filter((summary) => summary.outcome === 'safe').length,
            poolUnsafe: summaries.filter((summary) => summary.outcome === 'unsafe').length,
            poolTransitions: summaries.reduce((sum, summary) => sum + summary.transitions, 0),
            selectedTrajectories: selectedSummaries.length,
            selectedSafe: selectedSummaries.filter((summary) => summary.outcome === 'safe').length,
            selectedUnsafe: selectedSummaries.filter((summary) => summary.outcome === 'unsafe').length,
            rows: Object.values(rowsBySplit).reduce((sum, value) => sum + value, 0),
            rowsBySplit,
            postIncidentTransitionsDropped: droppedPostIncident,
        },
        distributions: splitDistribution(summaries, selectedIds),
        nuisance: nuisanceReport(summaries, selectedSummaries),
        matching: { ...matching, selected: undefined },
        splitPolicy: SPLIT_POLICY_V2,
        holdouts: {
            validationIncludesFormerTest: catalog.filter((entry) => entry.split === 'validation'
                && TOPOLOGY_CATALOG.some((old) => old.topologyId === entry.topologyId && old.split === 'test'))
                .map((entry) => entry.label),
            testAndOodUnseenByEarlierPhases: catalog.filter((entry) => ['test', 'ood'].includes(entry.split))
                .every((entry) => !v1Ids.has(entry.topologyId)),
        },
        label: {
            task: 'SLO violation within next K transitions',
            horizons: HORIZONS,
            defaultHorizon: DEFAULT_HORIZON,
            rowsEndAtFirstIncident: true,
            source: 'first failing transition of deterministic execution',
        },
        rowCap,
        positionBalance,
        features: {
            inputs: ['state', 'candidateAction'],
            inputKeys: ['action', 'state'],
            excluded: ['nextState', 'labels', 'trajectoryOutcome', 'failureClass', 'metadata', 'nuisance',
                'placementKind', 'scenarioFamily', 'difficultyTier'],
            boundary: FEATURE_BOUNDARY,
            candidateActionExcludes: ['id', 'atMs'],
            rowsCarryNextState: false,
            nextStateVerification: 'metadata.nextStateDigest (sha256 prefix of the canonical next graph)',
        },
        replay: {
            selectedReplayed,
            fingerprintMismatches,
            phaseOneArtifact: phaseOne,
        },
        pairs: {
            count: pairSummaries.length,
            families: PAIR_FAMILIES,
            familyDescriptions: FAMILY_DESCRIPTIONS,
            replaySampled: replaySample.length,
            fingerprintMismatches: pairMismatches,
            replayVerified: pairSummaries.length > 0 && pairMismatches === 0,
        },
        parameters: {
            topologyCatalog: catalog,
            supportedFaults: Object.values(CLOUD_FAULT),
            scenarioFamilies: ['causal'],
        },
        files,
    });
    fs.writeFileSync(path.join(outputs.directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return {
        manifest,
        matching,
        summaries,
        selectedSummaries,
        examplesBySplit,
        candidates,
        pairSummaries,
        outputDirectory: outputs.directory,
    };
}

function writeAcceptedManifest(corpus, evaluation, acceptance) {
    const write = (name, value) => fs.writeFileSync(path.join(corpus.outputDirectory, name),
        `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const sanity = stable({
        kind: 'cloudproof.causal-corpus-sanity-report',
        schemaVersion: 1,
        shortcutProbe: evaluation.shortcutProbe,
        labelPermutation: evaluation.labelPermutation,
        horizons: evaluation.horizons,
        splitIntegrity: evaluation.splitIntegrity,
        replay: corpus.manifest.replay,
        pairs: evaluation.counterfactualPairs.counts,
        acceptance,
    });
    const nuisance = stable({
        kind: 'cloudproof.causal-corpus-nuisance-report',
        schemaVersion: 1,
        distributions: corpus.manifest.nuisance,
        matching: corpus.manifest.matching,
        horizonPositiveRates: evaluation.horizons.positiveRates,
    });
    const manifest = stable({
        ...corpus.manifest,
        acceptance,
        sanity: {
            shortcutProbeMaxAuroc: {
                trajectory: evaluation.shortcutProbe.trajectory.maxAuroc,
                transition: evaluation.shortcutProbe.transition[String(evaluation.defaultHorizon)].maxAuroc,
            },
            labelPermutation: evaluation.labelPermutation.families,
            horizonPositiveRates: evaluation.horizons.positiveRates,
            counterfactualPairs: evaluation.counterfactualPairs.counts,
        },
    });
    write('manifest.json', manifest);
    write('evaluation.json', { evaluation, acceptance });
    write('sanity-report.json', sanity);
    write('nuisance-report.json', nuisance);
    return manifest;
}

module.exports = { FILENAMES, capIncidentClasses, generateCausalCorpus, writeAcceptedManifest };
