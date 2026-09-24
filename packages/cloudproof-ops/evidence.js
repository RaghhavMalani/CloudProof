'use strict';

// Evidence bundles: everything needed to re-check a verification elsewhere.
//
// A bundle carries the topology, the change, the fault model, the search
// configuration, the invariants, and (when one was found) the original and
// minimal counterexample traces. Its digests are SHA-256 over canonical JSON
// (sha256.js), so a bundle exported by the browser verifies byte-for-byte in
// Node. `verifyEvidence` re-executes the minimal trace and, optionally, the
// whole search.

const { stable } = require('../cloudproof-mesh/world');
const { changeSummary } = require('./changes');
const { applyReadinessDelay } = require('./faults');
const { describeInvariant } = require('./invariants');
const { canonicalDigest } = require('./sha256');
const { SEARCH_VERSION, replayTrace, verifyChange } = require('./verify');

const EVIDENCE_KIND = 'cloudproof.ops-evidence';
const EVIDENCE_SCHEMA_VERSION = 1;
const OPS_BUILD = 'cloudproof-ops 0.1.0';

function verdictStatement(result) {
    if (result.status === 'counterexample') {
        return `Counterexample found after ${result.counters.schedulesChecked} explored schedule${result.counters.schedulesChecked === 1 ? '' : 's'}.`;
    }
    if (result.status === 'verified') {
        return `No modeled invariant violation found across ${result.counters.schedulesChecked} explored schedules (fault budget ${result.maxFaults}, seed ${result.seed}). Verified within this bound only.`;
    }
    return `Search ${result.status} after ${result.counters.schedulesChecked} schedules; no verdict.`;
}

function replayOutcome(world, trace, invariants) {
    const replay = replayTrace(world, trace, invariants);
    if (replay.invalid) return { invalid: true };
    const state = replay.finalState;
    return {
        violations: (replay.violations || []).map(({ entry, entryStartMs, ...rest }) => rest),
        transitions: replay.transitions,
        final: stable({ clockMs: state.clockMs, rps: state.rps, pods: state.pods, zones: state.zones, nodes: state.nodes, services: state.services, derived: state.derived }),
    };
}

/** Digest of what replaying a trace produces, not just of the trace. */
function replayDigest(world, trace, invariants) {
    const outcome = replayOutcome(world, trace, invariants);
    return canonicalDigest({ actions: trace.map((entry) => entry.action), outcome });
}

function searchDigest(result) {
    return canonicalDigest({
        status: result.status,
        counters: result.counters,
        scheduleRange: result.scheduleRange,
        horizonMs: result.horizonMs,
        counterexample: result.counterexample ? { index: result.counterexample.scheduleIndex, label: result.counterexample.label, primary: result.counterexample.primary } : null,
    });
}

function bundleDigest(bundle) {
    const { exportedAt, digests, ...rest } = bundle;
    return canonicalDigest({ ...rest, digests: { ...digests, bundle: null } });
}

/**
 * Build a bundle from a finished search and (optional) shrink result.
 * `exportedAt` is the only field that is not a function of the run, and it
 * is excluded from the bundle digest.
 */
function buildEvidence({ scenario, config, result, shrink = null, exportedAt = null }) {
    const world = config.world;
    const counterexample = result.counterexample;
    let counterexampleBlock = null;
    if (counterexample) {
        const effective = counterexample.readiness ? applyReadinessDelay(world) : world;
        const minimal = shrink ? shrink.minimal : null;
        counterexampleBlock = {
            scheduleIndex: counterexample.scheduleIndex,
            label: counterexample.label,
            placements: counterexample.placements,
            readinessDelay: counterexample.readiness,
            atMs: counterexample.atMs,
            primary: counterexample.primary,
            violations: counterexample.violations,
            cause: counterexample.cause,
            withoutChange: counterexample.withoutChange,
            effectiveWorldDigest: canonicalDigest(effective),
            original: { actions: counterexample.trace.length, transitions: counterexample.transitions, trace: counterexample.trace },
            minimal: minimal ? {
                actions: minimal.actions,
                transitions: minimal.transitions,
                trace: minimal.trace,
                primary: minimal.primary,
                replayDigest: replayDigest(effective, minimal.trace, config.invariants),
            } : null,
            shrinkSteps: shrink ? shrink.steps : [],
            originalReplayDigest: replayDigest(effective, counterexample.trace, config.invariants),
        };
    }
    const bundle = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        kind: EVIDENCE_KIND,
        build: { ops: OPS_BUILD, search: SEARCH_VERSION, engine: 'packages/cloudproof-mesh (Phase III)' },
        exportedAt,
        scenario: { id: scenario?.id || config.scenarioId || null, name: scenario?.name || null },
        topology: { digest: canonicalDigest(world), world },
        labels: config.labels || {},
        versions: config.versions || {},
        change: config.change,
        changeSummary: changeSummary(config.change),
        faultModel: { families: config.faults, maxFaults: config.maxFaults, variants: result.faultVariants },
        search: {
            seed: result.seed,
            budget: result.budget,
            horizonMs: result.horizonMs,
            faultWindow: result.faultWindow,
            scheduleRange: result.scheduleRange,
            counters: result.counters,
            status: result.status,
        },
        invariants: config.invariants.map((item) => ({ ...item, description: describeInvariant(item, config.labels) })),
        verdict: { status: result.status === 'verified' ? 'verified-within-bound' : result.status, statement: verdictStatement(result) },
        counterexample: counterexampleBlock,
        preExisting: { count: result.counters.preExisting, classes: result.preExistingClasses || [] },
        digests: { search: searchDigest(result), bundle: null },
    };
    bundle.digests.bundle = bundleDigest(bundle);
    return stable(bundle);
}

/**
 * Check a bundle: its own digest, its topology digest, and that replaying the
 * minimal counterexample reproduces the recorded outcome. With
 * `rerunSearch`, the whole search is repeated and compared as well.
 */
function verifyEvidence(bundle, { rerunSearch = false } = {}) {
    const checks = [];
    const check = (name, ok, detail = null) => checks.push({ name, ok: Boolean(ok), detail });
    if (!bundle || bundle.kind !== EVIDENCE_KIND || bundle.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
        check('bundle kind', false, `expected ${EVIDENCE_KIND} v${EVIDENCE_SCHEMA_VERSION}`);
        return { ok: false, checks };
    }
    check('bundle digest', bundleDigest(bundle) === bundle.digests.bundle);
    const world = bundle.topology.world;
    check('topology digest', canonicalDigest(world) === bundle.topology.digest);
    const invariants = bundle.invariants.map(({ description, ...rest }) => rest);
    if (bundle.counterexample) {
        const effective = bundle.counterexample.readinessDelay ? applyReadinessDelay(world) : world;
        check('effective world digest', canonicalDigest(effective) === bundle.counterexample.effectiveWorldDigest);
        check('original trace replays', replayDigest(effective, bundle.counterexample.original.trace, invariants) === bundle.counterexample.originalReplayDigest);
        if (bundle.counterexample.minimal) {
            const minimal = bundle.counterexample.minimal;
            check('minimal trace replays', replayDigest(effective, minimal.trace, invariants) === minimal.replayDigest);
            const outcome = replayOutcome(effective, minimal.trace, invariants);
            check('minimal trace violates the recorded invariant', (outcome.violations || []).some((item) => item.invariant === minimal.primary.invariant));
        }
    }
    if (rerunSearch) {
        const result = verifyChange({
            world, versions: bundle.versions, labels: bundle.labels, change: bundle.change, invariants,
            faults: bundle.faultModel.families, maxFaults: bundle.faultModel.maxFaults,
            budget: bundle.search.budget.name === 'custom' ? bundle.search.budget.schedules : bundle.search.budget.name,
            seed: bundle.search.seed,
        });
        check('search re-run matches', searchDigest(result) === bundle.digests.search, `${result.status} after ${result.counters.schedulesChecked} schedules`);
    }
    return { ok: checks.every((item) => item.ok), checks };
}

module.exports = {
    EVIDENCE_KIND,
    OPS_BUILD,
    buildEvidence,
    bundleDigest,
    replayDigest,
    searchDigest,
    verdictStatement,
    verifyEvidence,
};
