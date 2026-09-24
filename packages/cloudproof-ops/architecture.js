'use strict';

// Architecture what-if: the Phase III counterfactual pairs, made visible.
//
// Pairs come from packages/cloudproof-mesh/pairs.js unchanged: two worlds with
// the same services, replicas, capacities, placement and per-node degrees,
// differing by one degree-preserving swap inside one relation type, receiving
// the same fault. `findDecisivePair` walks seeds until the simulator gives the
// two members different outcomes; both members are then replayed step by step.

const { PAIR_FAMILIES, buildPair, evaluatePair } = require('../cloudproof-mesh/pairs');
const { TEMPLATES } = require('../cloudproof-mesh/generator');
const { MESH_ACTION } = require('../cloudproof-mesh/constants');
const { edgeId } = require('./graph-model');
const { buildTimeline, explainViolation } = require('./explain');
const { replayTrace } = require('./verify');

const FAMILY_COPY = Object.freeze({
    'route-entry': { title: 'Which API the busy route enters', relation: 'ENTERS', fault: 'node crash' },
    'call-dependency': { title: 'Which twin API the busy entry calls', relation: 'CALLS', fault: 'node crash' },
    'cache-backing': { title: 'Which store a flushed cache falls through to', relation: 'BACKED_BY', fault: 'cache flush' },
    'storage-zone': { title: 'Which zonal database the busy writer uses', relation: 'WRITES', fault: 'zone degradation' },
    'queue-consumer': { title: 'Which worker drains the busy queue', relation: 'CONSUMES', fault: 'node crash' },
});

const SLO = Object.freeze([{ id: 'error-budget', kind: 'error-budget', maxPct: 20 }]);

function families() {
    return PAIR_FAMILIES.map((id) => ({ id, ...FAMILY_COPY[id] }));
}

function templates() {
    return TEMPLATES.filter((item) => item.split === 'train').map((item) => item.id);
}

const KIND_SHORT = { api: 'api', cache: 'cache', queue: 'queue', worker: 'worker', database: 'db' };

/** Readable labels for generated ids: "api 07", "db 03 (replica)". */
function generatedLabels(world) {
    return Object.fromEntries(world.services.map((service) => {
        const number = service.id.replace(/^svc-/, '');
        const role = service.role === 'replica' ? ' (replica)' : '';
        return [service.id, `${KIND_SHORT[service.kind]} ${number}${role}`];
    }));
}

/** First decisive, valid pair at or after `seed`. */
function findDecisivePair({ family, templateId = 'T1', seed = 1, maxTries = 40 }) {
    if (!PAIR_FAMILIES.includes(family)) throw new TypeError(`unknown pair family: ${family}`);
    const skipped = [];
    for (let offset = 0; offset < maxTries; offset += 1) {
        const candidate = seed + offset;
        const pair = buildPair({ seed: candidate, family, templateId });
        const evaluation = evaluatePair(pair);
        if (evaluation.valid && evaluation.decisive) return { pair, evaluation, seed: candidate, skipped };
        skipped.push({ seed: candidate, valid: evaluation.valid, decisive: evaluation.decisive });
    }
    return null;
}

function scheduleTrace(schedule) {
    let clock = 0;
    return schedule.actions.map((action) => {
        const entry = {
            action,
            origin: action.type === MESH_ACTION.ADVANCE_TIME ? 'time' : 'fault',
            label: null,
            atMs: clock,
        };
        if (action.type === MESH_ACTION.ADVANCE_TIME) clock += action.ms;
        return entry;
    });
}

/**
 * Replay both members of a pair on the same schedule. Returns per-member
 * timelines, the wiring edges that differ, and the explanation for whichever
 * member violated the SLO.
 */
function pairReplay(found) {
    const { pair, evaluation } = found;
    const members = {};
    const edgeSets = {};
    for (const member of ['A', 'B']) {
        const schedule = pair.schedules[member];
        const world = schedule.world;
        const labels = generatedLabels(world);
        const trace = scheduleTrace(schedule);
        const timeline = buildTimeline(world, trace, SLO, { labels });
        const replay = replayTrace(world, trace, SLO);
        let explanation = null;
        if (replay.violations) {
            const upTo = trace.slice(0, replay.violations[0].entry + 1);
            explanation = explainViolation(replay.finalState, replay.violations[0], SLO, { trace: upTo.filter((entry) => entry.origin !== 'time'), labels });
        }
        edgeSets[member] = new Set([
            ...world.dependencies.map(edgeId),
            ...world.routes.map((route) => `ENTERS:${route.id}->${route.entry}`),
        ]);
        members[member] = {
            wiring: pair.order[member],
            world,
            labels,
            timeline,
            violated: Boolean(replay.violations),
            violation: replay.violations ? replay.violations[0] : null,
            explanation,
            truth: evaluation.truth[member],
        };
    }
    const differing = {
        A: [...edgeSets.A].filter((id) => !edgeSets.B.has(id)).sort(),
        B: [...edgeSets.B].filter((id) => !edgeSets.A.has(id)).sort(),
    };
    return {
        pairId: pair.pairId,
        family: pair.family,
        familyTitle: FAMILY_COPY[pair.family].title,
        template: pair.template,
        seed: found.seed,
        skippedSeeds: found.skipped,
        swappedRelation: pair.swappedRelation,
        fault: pair.fault,
        criticalRoute: pair.criticalRoute,
        motif: pair.motif,
        assertions: evaluation.assertions,
        riskier: evaluation.riskier,
        hopsFromFaultToCriticalRoute: evaluation.hopsFromFaultToCriticalRoute,
        differing,
        members,
    };
}

module.exports = { FAMILY_COPY, families, findDecisivePair, generatedLabels, pairReplay, templates };
