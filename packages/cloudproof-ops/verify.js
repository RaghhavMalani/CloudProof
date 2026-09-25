'use strict';

// Bounded, deterministic verification of one proposed change.
//
// The search explores schedules: the change's controller running while
// exogenous faults are injected at chosen times. Every schedule executes on
// the CloudProof Mesh engine; the modeled invariants in invariants.js are
// checked after every instant action and every 100 ms tick. A violation only
// counts against the change when the same faults, without the change, do not
// violate the same invariant; otherwise it is reported as a pre-existing risk.
//
// Given the same configuration and seed, the search visits the same schedules
// in the same order and returns the same result, however it is chunked.

const { Rng } = require('../../sim/simulator');
const { MESH_ACTION, TIMING } = require('../cloudproof-mesh/constants');
const { createMeshState, step, tick } = require('../cloudproof-mesh/engine');
const { validateWorld } = require('../cloudproof-mesh/world');
const { changeSummary, createController, validateChange } = require('./changes');
const { applyReadinessDelay, expandPlacements, faultVariants, placementLabel, validateFamilies } = require('./faults');
const { rootCauseOf } = require('./causes');
const { createMonitor, observeAll, validateInvariants } = require('./invariants');

const BUDGETS = Object.freeze({ quick: 100, standard: 500, deep: 1000, exhaustive: 2500 });
const SEARCH_VERSION = 'cloudproof-ops/verify@1';
const DEFAULTS = Object.freeze({ slotMs: 500, settleMs: 8000, windowMs: 4000, minHorizonMs: 10_000, maxHorizonMs: 40_000 });
const FAULT_BUDGET = Object.freeze({ min: 1, max: 3, default: 1 });

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

// Two FNV-1a lanes over a coarse state signature. Clocks and timers are left
// out so that "unique states" counts distinct configurations, not instants.
function stateKey(state) {
    let text = `${state.rps}|`;
    for (const pod of state.pods) text += `${pod.id}:${pod.phase}:${pod.node || '-'};`;
    for (const [id, zone] of Object.entries(state.zones)) text += `${id}${zone.degraded ? 'D' : 'u'}`;
    for (const [id, node] of Object.entries(state.nodes)) text += `${id}${node.crashed ? 'X' : ''}${node.cordoned ? 'C' : ''}`;
    for (const [id, runtime] of Object.entries(state.services)) {
        text += `${id}:${runtime.promoted ? 'P' : ''}${runtime.coldUntilMs > state.clockMs ? 'K' : ''}${runtime.stalledUntilMs > state.clockMs ? 'S' : ''}${Math.round(runtime.backlog / 50)};`;
    }
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ 0x5bd1e995;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        a = Math.imul(a ^ code, 16777619);
        b = Math.imul(b ^ code, 2246822519);
    }
    return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

function traceEntry(action, origin, label, atMs, variant = null) {
    return { action: clone(action), origin, label, atMs, ...(variant ? { variant } : {}) };
}

/**
 * Execute one schedule. Returns the first violating instant (all invariants
 * violated at that instant) or, with stopOnViolation false, every invariant
 * id violated at any point in the horizon.
 */
function runSchedule({
    world, change = null, versions = {}, invariants, faultActions = [], horizonMs,
    stopOnViolation = true, recordTrace = true, stateKeys = null, onState = null,
}) {
    let state = createMeshState(world);
    const monitors = invariants.map(createMonitor);
    const initial = observeAll(monitors, state);
    if (initial.length) return { invalid: true, reason: 'the world violates an invariant before anything happens', violations: initial };
    const controller = change ? createController(world, change, versions) : null;
    const faults = faultActions.slice();
    const trace = [];
    const violatedIds = new Set();
    let pendingMs = 0;
    let pendingStart = 0;
    let transitions = 0;
    let violations = null;
    let changeCompleteAtMs = controller ? null : 0;
    let cursor = 0;
    const flush = () => {
        if (pendingMs && recordTrace) {
            trace.push(traceEntry({ type: MESH_ACTION.ADVANCE_TIME, ms: pendingMs }, 'time', null, pendingStart));
        }
        pendingMs = 0;
    };
    const check = () => {
        if (stateKeys) stateKeys.add(stateKey(state));
        if (onState) onState(state);
        const found = observeAll(monitors, state);
        for (const item of found) violatedIds.add(item.invariant);
        if (found.length && !violations) violations = found;
        return stopOnViolation && violations;
    };
    const apply = (action, origin, label, variant) => {
        flush();
        const atMs = state.clockMs;
        state = step(state, action).state;
        transitions += 1;
        if (recordTrace) trace.push(traceEntry(action, origin, label, atMs, variant));
        return check();
    };
    outer: for (;;) {
        while (cursor < faults.length && faults[cursor].atMs <= state.clockMs) {
            const fault = faults[cursor];
            cursor += 1;
            if (apply(fault.action, 'fault', fault.label, fault.variant)) break outer;
        }
        if (controller && !controller.complete) {
            for (const item of controller.next(state)) {
                if (apply(item.action, 'change', item.label)) break outer;
            }
            if (controller.complete && changeCompleteAtMs === null) changeCompleteAtMs = state.clockMs;
        }
        if (state.clockMs >= horizonMs) break;
        if (!pendingMs) pendingStart = state.clockMs;
        tick(state);
        pendingMs += TIMING.tickMs;
        transitions += 1;
        if (check()) break;
    }
    flush();
    return {
        invalid: false,
        violations,
        violatedIds,
        atMs: violations ? violations[0].atMs : null,
        trace,
        transitions,
        changeCompleteAtMs,
        finalState: state,
    };
}

function traceTransitions(trace) {
    return trace.reduce((sum, entry) => sum + (entry.action.type === MESH_ACTION.ADVANCE_TIME ? entry.action.ms / TIMING.tickMs : 1), 0);
}

/**
 * Re-execute a materialized trace (the actions a run actually took). Replay
 * checks invariants at exactly the instants the original run did, so a trace
 * cut at its first violation reproduces that violation.
 */
function replayTrace(world, trace, invariants, { onStep = null, stopOnViolation = true } = {}) {
    let state = createMeshState(world);
    const monitors = invariants.map(createMonitor);
    let violations = observeAll(monitors, state);
    if (violations.length) return { invalid: true, violations };
    violations = null;
    let transitions = 0;
    let index = 0;
    let entryStartMs = 0;
    const violatedIds = new Set();
    const check = (entryIndex) => {
        const found = observeAll(monitors, state);
        for (const item of found) violatedIds.add(item.invariant);
        if (found.length && !violations) violations = found.map((item) => ({ ...item, entry: entryIndex, entryStartMs }));
        return stopOnViolation && violations;
    };
    for (; index < trace.length; index += 1) {
        const entry = trace[index];
        entryStartMs = state.clockMs;
        const before = onStep ? clone(state) : null;
        let stop = false;
        if (entry.action.type === MESH_ACTION.ADVANCE_TIME) {
            const ms = entry.action.ms;
            if (!Number.isInteger(ms) || ms < TIMING.tickMs || ms % TIMING.tickMs !== 0) throw new TypeError('advance-time must be a positive multiple of 100 ms');
            for (let elapsed = 0; elapsed < ms; elapsed += TIMING.tickMs) {
                tick(state);
                transitions += 1;
                if (check(index)) { stop = true; break; }
            }
        } else {
            state = step(state, entry.action).state;
            transitions += 1;
            stop = Boolean(check(index));
        }
        if (onStep) onStep({ index, entry, before, after: clone(state), violations: stop ? violations : null });
        if (stop) break;
    }
    return { invalid: false, violations, violatedIds, transitions, finalState: state };
}

function resolveBudget(budget) {
    if (typeof budget === 'number') {
        if (!Number.isInteger(budget) || budget < 1 || budget > BUDGETS.exhaustive) throw new TypeError(`budget must be an integer in [1, ${BUDGETS.exhaustive}]`);
        return { name: 'custom', schedules: budget };
    }
    if (!BUDGETS[budget]) throw new TypeError(`unknown budget: ${budget}`);
    return { name: budget, schedules: BUDGETS[budget] };
}

function shuffle(rng, items) {
    const out = items.slice();
    for (let index = out.length - 1; index > 0; index -= 1) {
        const swap = rng.int(index + 1);
        [out[index], out[swap]] = [out[swap], out[index]];
    }
    return out;
}

function scheduleKey(placements, readiness) {
    return placements.map((item) => `${item.variant}@${item.atMs}`).sort().join('+') + (readiness ? '+R' : '');
}

/**
 * Deterministic verification search. Construct it, call `run(options)` until
 * `done`, then read `result()`. `run` honours a wall-clock slice so the page
 * can yield; the slice changes how much work happens per call, never which
 * schedules run or what they find.
 */
class VerificationSearch {
    constructor(config) {
        const {
            world, versions = {}, labels = {}, change, invariants, faults = [], budget = 'standard', seed = 1337,
            scenarioId = null, maxFaults = FAULT_BUDGET.default, options = {},
        } = config;
        validateWorld(world);
        validateChange(world, change);
        validateInvariants(world, invariants);
        validateFamilies(faults);
        if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('seed must be a 32-bit unsigned integer');
        if (!Number.isInteger(maxFaults) || maxFaults < FAULT_BUDGET.min || maxFaults > FAULT_BUDGET.max) {
            throw new TypeError(`maxFaults must be an integer in [${FAULT_BUDGET.min}, ${FAULT_BUDGET.max}]`);
        }
        this.options = { ...DEFAULTS, ...options };
        // Fault families are a set: keep them sorted so every caller records the same thing.
        this.config = clone({ scenarioId, world, versions, labels, change, invariants, faults: [...new Set(faults)].sort(), seed, maxFaults });
        this.budget = resolveBudget(budget);
        this.world = this.config.world;
        this.slowWorld = faults.includes('readiness-delay') ? applyReadinessDelay(this.world) : null;
        this.variants = faultVariants(this.world, faults.filter((family) => family !== 'readiness-delay'));
        this.variantsById = new Map(this.variants.map((variant) => [variant.id, variant]));
        this.stateKeys = new Set();
        this.combinations = new Set();
        this.seen = new Set();
        this.recent = [];
        this.counters = { schedules: 0, transitions: 0, singles: 0, multi: 0, preExisting: 0, attributionRuns: 0 };
        this.status = 'running';
        this.counterexample = null;
        this.preExisting = null;
        this.preExistingClasses = new Map();
        this.elapsedMs = 0;

        // The change on a quiet world sets the horizon and the fault window.
        const timing = runSchedule({
            world: this.world, change, versions, invariants, horizonMs: this.options.maxHorizonMs,
            stopOnViolation: false, recordTrace: false,
        });
        if (timing.invalid) throw new TypeError(timing.reason);
        const completion = timing.changeCompleteAtMs ?? this.options.maxHorizonMs;
        this.changeCompleteAtMs = timing.changeCompleteAtMs;
        this.horizonMs = Math.min(this.options.maxHorizonMs, Math.max(this.options.minHorizonMs, completion + this.options.settleMs));
        const windowEnd = Math.min(this.horizonMs - 2000, completion + this.options.windowMs);
        this.slots = [];
        for (let atMs = 0; atMs <= windowEnd; atMs += this.options.slotMs) this.slots.push(atMs);

        const rng = new Rng(seed ^ 0x6f70735f);
        const singles = [];
        for (const variant of this.variants) {
            for (const atMs of this.slots) singles.push({ placements: [{ variant: variant.id, atMs }], readiness: false });
        }
        if (this.slowWorld) singles.push({ placements: [], readiness: true });
        this.singles = shuffle(rng, singles);
        this.singleCursor = 0;
        this.rng = rng;
        this.index = 0;
        this.multiExhausted = maxFaults < 2 || (this.variants.length < 2 && !(this.slowWorld && this.variants.length));
    }

    get done() {
        return this.status !== 'running';
    }

    // Schedule 0 is the change on a quiet world; then two singles for every
    // sampled multi-fault schedule, then multi-fault schedules only.
    nextSchedule() {
        if (this.index === 0) return { placements: [], readiness: false, kind: 'baseline' };
        const wantMulti = this.index % 3 === 0 || this.singleCursor >= this.singles.length;
        if (!wantMulti || this.multiExhausted) {
            if (this.singleCursor < this.singles.length) return { ...this.singles[this.singleCursor++], kind: 'single' };
            if (this.multiExhausted) return null;
        }
        // Readiness delay counts against the fault budget like any other fault.
        const budget = this.config.maxFaults;
        for (let attempt = 0; attempt < 64; attempt += 1) {
            const readiness = Boolean(this.slowWorld) && this.rng.chance(0.25);
            const room = budget - (readiness ? 1 : 0);
            const count = Math.min(this.variants.length, room, room >= 3 && this.rng.chance(0.3) ? 3 : 2);
            const pool = shuffle(this.rng, this.variants.map((variant) => variant.id)).slice(0, Math.max(1, count));
            if (pool.length + (readiness ? 1 : 0) < 2) continue;
            const placements = pool.map((variant) => ({ variant, atMs: this.rng.pick(this.slots) }))
                .sort((left, right) => left.atMs - right.atMs || left.variant.localeCompare(right.variant));
            const key = scheduleKey(placements, readiness);
            if (this.seen.has(key)) continue;
            return { placements, readiness, kind: 'multi' };
        }
        this.multiExhausted = true;
        return this.singleCursor < this.singles.length ? { ...this.singles[this.singleCursor++], kind: 'single' } : null;
    }

    runOne() {
        const schedule = this.nextSchedule();
        if (!schedule) { this.status = 'verified'; return; }
        const index = this.index;
        this.index += 1;
        const key = scheduleKey(schedule.placements, schedule.readiness);
        this.seen.add(key);
        this.combinations.add(schedule.placements.map((item) => item.variant).sort().join('+') + (schedule.readiness ? '+R' : ''));
        const world = schedule.readiness ? this.slowWorld : this.world;
        const faultActions = expandPlacements(schedule.placements, this.variantsById);
        const run = runSchedule({
            world, change: this.config.change, versions: this.config.versions, invariants: this.config.invariants,
            faultActions, horizonMs: this.horizonMs, stateKeys: this.stateKeys,
        });
        this.counters.schedules += 1;
        this.counters.transitions += run.transitions;
        if (schedule.kind === 'single') this.counters.singles += 1;
        if (schedule.kind === 'multi') this.counters.multi += 1;
        const label = schedule.kind === 'baseline' ? 'change alone, no faults' : placementLabel(schedule.placements, schedule.readiness, this.variantsById);
        let outcome = 'checked';
        if (run.violations) {
            const baseline = runSchedule({
                world, change: null, invariants: this.config.invariants, faultActions, horizonMs: this.horizonMs,
                stopOnViolation: false, recordTrace: false,
            });
            this.counters.attributionRuns += 1;
            this.counters.transitions += baseline.transitions;
            const attributable = run.violations.filter((item) => !baseline.violatedIds.has(item.invariant));
            const first = attributable[0] || run.violations[0];
            const cause = rootCauseOf(run.finalState, first, this.config.invariants.find((item) => item.id === first.invariant));
            const record = {
                scheduleIndex: index,
                kind: schedule.kind,
                label,
                placements: schedule.placements,
                readiness: schedule.readiness,
                faultActions,
                world,
                trace: run.trace,
                transitions: run.transitions,
                violations: run.violations,
                atMs: run.atMs,
                cause: { root: cause.root, incidentClass: cause.incidentClass, route: cause.route, chain: cause.chain },
                withoutChange: [...baseline.violatedIds].sort(),
            };
            if (attributable.length) {
                outcome = 'violation';
                this.counterexample = { ...record, primary: attributable[0], attributable };
                this.status = 'counterexample';
            } else {
                outcome = 'pre-existing';
                this.counters.preExisting += 1;
                if (!this.preExisting) this.preExisting = { ...record, primary: run.violations[0] };
                const key = `${first.invariant}|${cause.root}|${cause.incidentClass}`;
                const known = this.preExistingClasses.get(key);
                if (known) known.count += 1;
                else {
                    this.preExistingClasses.set(key, {
                        invariant: first.invariant,
                        rootService: cause.root,
                        incidentClass: cause.incidentClass,
                        count: 1,
                        example: label,
                        exampleIndex: index,
                    });
                }
            }
        }
        this.recent.push({ index, label, outcome, kind: schedule.kind });
        if (this.recent.length > 8) this.recent.shift();
        if (!this.done && this.counters.schedules >= this.budget.schedules) this.status = 'verified';
    }

    /** Run until done, `maxSchedules` more schedules, or `sliceMs` of wall clock. */
    run({ sliceMs = Infinity, maxSchedules = Infinity, now = () => Date.now() } = {}) {
        const started = now();
        let ran = 0;
        while (!this.done && ran < maxSchedules) {
            this.runOne();
            ran += 1;
            if (now() - started >= sliceMs) break;
        }
        this.elapsedMs += now() - started;
        return this.progress();
    }

    cancel() {
        if (!this.done) this.status = 'cancelled';
    }

    progress() {
        return {
            status: this.status,
            schedulesChecked: this.counters.schedules,
            budget: this.budget.schedules,
            transitions: this.counters.transitions,
            uniqueStates: this.stateKeys.size,
            faultCombinations: this.combinations.size,
            singlesChecked: this.counters.singles,
            singlesTotal: this.singles.length,
            multiChecked: this.counters.multi,
            preExisting: this.counters.preExisting,
            violations: this.counterexample ? 1 : 0,
            currentSchedule: this.index,
            seed: this.config.seed,
            elapsedMs: this.elapsedMs,
            recent: this.recent.slice(),
        };
    }

    result() {
        const progress = this.progress();
        return {
            kind: 'cloudproof.ops-verification',
            searchVersion: SEARCH_VERSION,
            status: this.status,
            scenarioId: this.config.scenarioId,
            change: clone(this.config.change),
            changeSummary: changeSummary(this.config.change),
            faults: this.config.faults.slice(),
            maxFaults: this.config.maxFaults,
            invariants: clone(this.config.invariants),
            seed: this.config.seed,
            budget: this.budget,
            horizonMs: this.horizonMs,
            changeCompleteAtMs: this.changeCompleteAtMs,
            faultWindow: { fromMs: this.slots[0] ?? 0, toMs: this.slots[this.slots.length - 1] ?? 0, slotMs: this.options.slotMs },
            faultVariants: this.variants.map(({ id, family, label }) => ({ id, family, label })),
            space: { singles: this.singles.length, slots: this.slots.length },
            scheduleRange: [0, Math.max(0, this.counters.schedules - 1)],
            counters: {
                schedulesChecked: progress.schedulesChecked,
                transitions: progress.transitions,
                uniqueStates: progress.uniqueStates,
                faultCombinations: progress.faultCombinations,
                singlesChecked: progress.singlesChecked,
                multiChecked: progress.multiChecked,
                preExisting: progress.preExisting,
            },
            counterexample: this.counterexample ? clone(this.counterexample) : null,
            preExisting: this.preExisting ? clone(this.preExisting) : null,
            preExistingClasses: [...this.preExistingClasses.values()].map(clone)
                .sort((left, right) => right.count - left.count || left.exampleIndex - right.exampleIndex),
        };
    }
}

/** Run a whole search synchronously (Node, tests, the CLI). */
function verifyChange(config) {
    const search = new VerificationSearch(config);
    search.run();
    return search.result();
}

/**
 * Replay one exogenous fault schedule against a (possibly different)
 * configuration. This is how a remediation is checked against the exact
 * environment of a counterexample.
 */
function replayEnvironment({ world, change, versions = {}, invariants, placements = [], readiness = false, faults = [], horizonMs }) {
    const baseWorld = readiness ? applyReadinessDelay(world) : world;
    const variants = faultVariants(world, faults.filter((family) => family !== 'readiness-delay'));
    const faultActions = expandPlacements(placements, new Map(variants.map((variant) => [variant.id, variant])));
    const run = runSchedule({ world: baseWorld, change, versions, invariants, faultActions, horizonMs });
    if (run.invalid) return { invalid: true, reason: run.reason };
    let attributable = null;
    if (run.violations) {
        const baseline = runSchedule({ world: baseWorld, change: null, invariants, faultActions, horizonMs, stopOnViolation: false, recordTrace: false });
        attributable = run.violations.filter((item) => !baseline.violatedIds.has(item.invariant));
    }
    return {
        invalid: false,
        violated: Boolean(run.violations),
        attributable: attributable || [],
        violations: run.violations,
        atMs: run.atMs,
        trace: run.trace,
        transitions: run.transitions,
        world: baseWorld,
        faultActions,
    };
}

module.exports = {
    BUDGETS,
    DEFAULTS,
    FAULT_BUDGET,
    SEARCH_VERSION,
    VerificationSearch,
    replayEnvironment,
    replayTrace,
    runSchedule,
    stateKey,
    traceTransitions,
    verifyChange,
};
