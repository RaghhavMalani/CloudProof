'use strict';

// CloudProof Operations Console: the product API over CloudProof Mesh.
//
// The browser page calls these functions and renders what they return. It
// does not reimplement any simulator behaviour: worlds, controllers, faults,
// invariants, search, shrinking and explanations all live here (and in
// packages/cloudproof-mesh), and run identically under Node.

const { createMeshState } = require('../cloudproof-mesh/engine');
const architecture = require('./architecture');
const { CHANGE_TYPES, DEFAULT_STRATEGY, changeSummary, describeChange, validateChange } = require('./changes');
const evidence = require('./evidence');
const { buildTimeline, explainViolation } = require('./explain');
const { FAULT_FAMILIES, applyReadinessDelay } = require('./faults');
const { graphModel, layoutWorld } = require('./graph-model');
const incidents = require('./incidents');
const { INVARIANT_KINDS, describeInvariant, validateInvariants } = require('./invariants');
const { applyRemediation, remediationsFor } = require('./remediation');
const { DEMOS, USE_CASES, demoById, listScenarios, loadScenario } = require('./scenarios');
const { canonicalDigest, sha256Hex } = require('./sha256');
const { TraceShrinker, shrinkTrace } = require('./shrink');
const topology = require('./topology');
const {
    BUDGETS, FAULT_BUDGET, VerificationSearch, replayEnvironment, replayTrace, verifyChange,
} = require('./verify');

/** Graph data for a world at rest (no simulation step taken). */
function initialGraph(world, meta = {}) {
    return graphModel(createMeshState(world), { ...meta, layout: meta.layout || layoutWorld(world) });
}

/**
 * Everything the counterexample player shows, from a trace that ends in a
 * violation: the per-step timeline, the explanation, and the attribution
 * state (the same faults without the change).
 */
function explainTrace({ world, trace, invariants, labels = {}, versions = {}, target = null, requireChange = true }) {
    const timeline = buildTimeline(world, trace, invariants, { labels, versions });
    const replay = replayTrace(world, trace, invariants);
    if (!replay.violations) return { timeline, explanation: null, violation: null };
    const violation = (target && replay.violations.find((item) => item.invariant === target)) || replay.violations[0];
    let withoutChange = null;
    if (requireChange) {
        const faultsOnly = trace.filter((entry) => entry.origin !== 'change');
        withoutChange = faultsOnly.length ? replayTrace(world, faultsOnly, invariants, { stopOnViolation: false }).finalState : createMeshState(world);
    }
    const clean = (({ entry, entryStartMs, ...rest }) => rest)(violation);
    const explanation = explainViolation(replay.finalState, clean, invariants, { trace, labels, withoutChange });
    return { timeline, explanation, violation: clean };
}

const ops = {
    version: evidence.OPS_BUILD,
    BUDGETS,
    FAULT_BUDGET,
    CHANGE_TYPES,
    DEFAULT_STRATEGY,
    FAULT_FAMILIES,
    INVARIANT_KINDS,
    DEMOS,
    USE_CASES,
    listScenarios,
    loadScenario,
    demoById,
    describeChange,
    changeSummary,
    validateChange,
    describeInvariant,
    validateInvariants,
    applyReadinessDelay,
    initialGraph,
    graphModel,
    layoutWorld,
    createVerification: (config) => new VerificationSearch(config),
    verifyChange,
    createShrinker: (options) => new TraceShrinker(options),
    shrinkTrace,
    replayTrace,
    replayEnvironment,
    explainTrace,
    remediationsFor,
    applyRemediation,
    architecture,
    incidents,
    topology,
    evidence,
    canonicalDigest,
    sha256Hex,
};

module.exports = ops;
