#!/usr/bin/env node
'use strict';

// Phase III-A.2 simulator-only pilot (CLOUDPROOF-PHASE-III-MULTISERVICE.md,
// sections 12-13). It reads simulator outcomes only: pair validity,
// decisiveness and balance per family, and natural-trajectory base rates.
// Pair outcomes are measured on train and validation templates only; test and
// OOD templates get a structural validity check whose outcomes are discarded,
// so the unseen split is not examined before the corpus rule is frozen.
//
//   node tools/cloudproof-mesh-pilot.js [--seeds 30] [--worlds 30] [--out artifacts/cloudproof/phase-iii-pilot/pilot.json]

const fs = require('node:fs');
const path = require('node:path');
const { generateWorld, naturalSchedule, TEMPLATES } = require('../packages/cloudproof-mesh/generator');
const { MOTIF, PAIR_FAMILIES, buildPair, evaluatePair } = require('../packages/cloudproof-mesh/pairs');
const { meshSchedule, runMeshSchedule } = require('../packages/cloudproof-mesh/runner');
const { stable } = require('../packages/cloudproof-mesh/world');

function argument(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : fallback;
}

const SEEDS = Number(argument('seeds', 30));
const WORLDS = Number(argument('worlds', 30));
const OUT = argument('out', 'artifacts/cloudproof/phase-iii-pilot/pilot.json');
const SEEN = TEMPLATES.filter((entry) => ['train', 'validation'].includes(entry.split));
const UNSEEN = TEMPLATES.filter((entry) => ['test', 'ood'].includes(entry.split));

function emptyCell() {
    return { pairs: 0, valid: 0, decisive: 0, bothUnsafe: 0, bothSafe: 0, canonicalRiskier: 0,
        riskierIsExposed: 0, failedAssertions: {}, hops: {}, incidentClasses: {} };
}

function pairPilot() {
    const cells = {};
    for (const family of PAIR_FAMILIES) {
        for (const entry of SEEN) {
            const cell = cells[`${family}|${entry.id}`] = emptyCell();
            for (let seed = 1; seed <= SEEDS; seed += 1) {
                const result = evaluatePair(buildPair({ seed, family, templateId: entry.id }));
                cell.pairs += 1;
                for (const [name, ok] of Object.entries(result.assertions)) {
                    if (!ok) cell.failedAssertions[name] = (cell.failedAssertions[name] || 0) + 1;
                }
                if (!result.valid) continue;
                cell.valid += 1;
                if (!result.decisive) {
                    if (result.truth.A.unsafe) cell.bothUnsafe += 1; else cell.bothSafe += 1;
                    continue;
                }
                cell.decisive += 1;
                cell.canonicalRiskier += Number(result.canonicalRiskier);
                cell.riskierIsExposed += Number(result.riskierIsExposed);
                const hops = String(result.hopsFromFaultToCriticalRoute);
                cell.hops[hops] = (cell.hops[hops] || 0) + 1;
                const incident = result.truth[result.riskier].failure.incidentClass;
                cell.incidentClasses[incident] = (cell.incidentClasses[incident] || 0) + 1;
            }
        }
    }
    const families = Object.fromEntries(PAIR_FAMILIES.map((family) => {
        const total = emptyCell();
        for (const [key, cell] of Object.entries(cells)) {
            if (!key.startsWith(`${family}|`)) continue;
            for (const field of ['pairs', 'valid', 'decisive', 'bothUnsafe', 'bothSafe', 'canonicalRiskier', 'riskierIsExposed']) {
                total[field] += cell[field];
            }
            for (const field of ['failedAssertions', 'hops', 'incidentClasses']) {
                for (const [name, count] of Object.entries(cell[field])) total[field][name] = (total[field][name] || 0) + count;
            }
        }
        total.decisiveRate = total.valid ? total.decisive / total.valid : null;
        total.canonicalRiskierShare = total.decisive ? total.canonicalRiskier / total.decisive : null;
        return [family, total];
    }));
    return { cells, families };
}

function unseenValidity() {
    const counts = { pairs: 0, valid: 0, errors: 0, failedAssertions: {} };
    for (const family of PAIR_FAMILIES) {
        for (const entry of UNSEEN) {
            for (let seed = 1; seed <= 3; seed += 1) {
                counts.pairs += 1;
                try {
                    const result = evaluatePair(buildPair({ seed: 1_000_000 + seed, family, templateId: entry.id }));
                    // Structural checks only; the outcome of an unseen pair is not kept.
                    if (result.valid) counts.valid += 1;
                    for (const [name, ok] of Object.entries(result.assertions)) {
                        if (!ok && name !== 'P5_sameNodesNoPreFaultViolation') {
                            counts.failedAssertions[name] = (counts.failedAssertions[name] || 0) + 1;
                        }
                    }
                } catch (error) {
                    counts.errors += 1;
                }
            }
        }
    }
    return counts;
}

function naturalPilot() {
    const byTemplate = {};
    for (const entry of SEEN) {
        const cell = byTemplate[entry.id] = { split: entry.split, trajectories: 0, unsafe: 0, rows: 0,
            firstIncidentTransitions: [], incidentClasses: {} };
        for (let seed = 1; seed <= WORLDS; seed += 1) {
            const { world } = generateWorld(seed, entry.id);
            const result = runMeshSchedule(meshSchedule({ seed, world, actions: naturalSchedule(seed, world).actions }));
            cell.trajectories += 1;
            cell.rows += result.rows.length;
            if (!result.outcome.unsafe) continue;
            cell.unsafe += 1;
            cell.firstIncidentTransitions.push(result.outcome.failure.transition);
            const incident = result.outcome.failure.incidentClass;
            cell.incidentClasses[incident] = (cell.incidentClasses[incident] || 0) + 1;
        }
        const sorted = cell.firstIncidentTransitions.sort((left, right) => left - right);
        cell.unsafeRate = cell.unsafe / cell.trajectories;
        cell.medianFirstIncident = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
        delete cell.firstIncidentTransitions;
    }
    return byTemplate;
}

const started = Date.now();
const pairs = pairPilot();
const report = stable({
    kind: 'cloudproof.phase-iii-pilot',
    schemaVersion: 1,
    scope: 'simulator outcomes only; pair outcomes on train and validation templates; no model, score or feature importance',
    parameters: { seedsPerFamilyTemplate: SEEDS, worldsPerTemplate: WORLDS, motif: MOTIF,
        seenTemplates: SEEN.map((entry) => entry.id), unseenTemplates: UNSEEN.map((entry) => entry.id) },
    pairs,
    unseenStructuralValidity: unseenValidity(),
    natural: naturalPilot(),
    elapsedSeconds: (Date.now() - started) / 1000,
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
for (const [family, total] of Object.entries(report.pairs.families)) {
    console.log(`${family.padEnd(16)} valid ${total.valid}/${total.pairs}  decisive ${total.decisive} (${(total.decisiveRate * 100).toFixed(0)}%)`
        + `  canonical-riskier ${(total.canonicalRiskierShare * 100).toFixed(0)}%  riskier=exposed ${total.riskierIsExposed}/${total.decisive}`
        + `  hops ${JSON.stringify(total.hops)}`);
}
console.log('unseen structural validity:', JSON.stringify(report.unseenStructuralValidity));
console.log(`wrote ${OUT} in ${report.elapsedSeconds.toFixed(1)} s`);
