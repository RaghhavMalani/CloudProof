'use strict';

// Counterexample minimisation.
//
// A counterexample is a materialized trace: the exact mesh actions a failing
// run took (change steps, faults, and time advancing between them). The
// shrinker removes whatever is not needed for the same invariant to fail,
// delta-debugging style, and records every reduction it keeps so the page can
// show the real sequence of sizes. For a change counterexample it also keeps
// the result about the change: the reduced trace must contain at least one
// change action, and must not fail the same way once those are removed.

const { MESH_ACTION, TIMING } = require('../cloudproof-mesh/constants');
const { replayTrace, traceTransitions } = require('./verify');

const isTime = (entry) => entry.action.type === MESH_ACTION.ADVANCE_TIME;

function advance(ms, atMs = 0) {
    return { action: { type: MESH_ACTION.ADVANCE_TIME, ms }, origin: 'time', label: null, atMs };
}

/** Merge adjacent time advances, drop empty ones, recompute entry times. */
function normalize(trace) {
    const out = [];
    for (const entry of trace) {
        if (isTime(entry)) {
            if (entry.action.ms <= 0) continue;
            const last = out[out.length - 1];
            if (last && isTime(last) && last.action.ms + entry.action.ms <= 60_000) {
                out[out.length - 1] = advance(last.action.ms + entry.action.ms);
                continue;
            }
            out.push(advance(entry.action.ms));
        } else {
            out.push({ ...entry, action: { ...entry.action } });
        }
    }
    let clock = 0;
    for (const entry of out) {
        entry.atMs = clock;
        if (isTime(entry)) clock += entry.action.ms;
    }
    return out;
}

class TraceShrinker {
    constructor({ world, trace, invariants, target, requireChange = true }) {
        this.world = world;
        this.invariants = invariants;
        this.target = target;
        this.requireChange = requireChange;
        this.tried = 0;
        this.status = 'running';
        const original = this.test(normalize(trace));
        if (!original) throw new TypeError(`the trace does not reproduce ${target}`);
        // The first step is the trace exactly as recorded; merging adjacent
        // waits is reported as a reduction of its own.
        this.original = { trace, actions: trace.length, transitions: traceTransitions(trace) };
        this.current = original;
        this.steps = [{ actions: this.original.actions, transitions: this.original.transitions, note: 'counterexample as found' }];
        if (original.trace.length < trace.length) {
            this.steps.push({ actions: original.trace.length, transitions: traceTransitions(original.trace), note: 'merged consecutive waits' });
        }
        this.work = this.phases();
    }

    get done() {
        return this.status !== 'running';
    }

    /**
     * Does `candidate` still fail the target invariant (and, for a change,
     * only because of the change)? Returns the candidate cut at its first
     * violating tick, or null.
     */
    test(candidate) {
        this.tried += 1;
        const trace = normalize(candidate);
        if (!trace.length) return null;
        if (this.requireChange && !trace.some((entry) => entry.origin === 'change')) return null;
        const replay = replayTrace(this.world, trace, this.invariants);
        if (replay.invalid || !replay.violations) return null;
        const hit = replay.violations.find((item) => item.invariant === this.target);
        if (!hit) return null;
        const cut = trace.slice(0, hit.entry + 1);
        const last = cut[cut.length - 1];
        if (isTime(last)) cut[cut.length - 1] = advance(hit.atMs - hit.entryStartMs);
        const result = normalize(cut);
        if (this.requireChange) {
            const without = result.filter((entry) => entry.origin !== 'change');
            if (without.length) {
                const other = replayTrace(this.world, without, this.invariants, { stopOnViolation: false });
                if (!other.invalid && other.violatedIds.has(this.target)) return null;
            }
        }
        return { trace: result, violations: replay.violations };
    }

    accept(found, note) {
        const smaller = found.trace.length < this.current.trace.length
            || (found.trace.length === this.current.trace.length && traceTransitions(found.trace) < traceTransitions(this.current.trace));
        if (!smaller) return false;
        this.current = found;
        this.steps.push({ actions: found.trace.length, transitions: traceTransitions(found.trace), note });
        return true;
    }

    * phases() {
        let progress = true;
        while (progress) {
            progress = false;
            // 1. Drop single actions: faults first (newest first), then change steps.
            for (const origin of ['fault', 'operation', 'change']) {
                for (let index = this.current.trace.length - 1; index >= 0; index -= 1) {
                    const entry = this.current.trace[index];
                    if (!entry || entry.origin !== origin) continue;
                    const candidate = this.current.trace.filter((_, position) => position !== index);
                    const found = this.test(candidate);
                    yield;
                    const what = { fault: 'fault', operation: 'operation', change: 'change step' }[origin];
                    if (found && this.accept(found, `removed ${what}: ${entry.label || entry.action.type.split('.').pop()}`)) progress = true;
                }
            }
            // 2. Drop contiguous chunks, halving the chunk size (ddmin).
            for (let size = Math.floor(this.current.trace.length / 2); size >= 2; size = Math.floor(size / 2)) {
                for (let start = 0; start + size <= this.current.trace.length; start += size) {
                    const candidate = this.current.trace.filter((_, position) => position < start || position >= start + size);
                    const found = this.test(candidate);
                    yield;
                    if (found && this.accept(found, `removed ${size} consecutive actions`)) { progress = true; break; }
                }
            }
            // 3. Time: drop each advance, then shorten it.
            for (let index = this.current.trace.length - 1; index >= 0; index -= 1) {
                const entry = this.current.trace[index];
                if (!entry || !isTime(entry)) continue;
                const without = this.test(this.current.trace.filter((_, position) => position !== index));
                yield;
                if (without && this.accept(without, `removed a ${(entry.action.ms / 1000).toFixed(1)} s wait`)) { progress = true; continue; }
                let ms = entry.action.ms;
                while (ms > TIMING.tickMs) {
                    const shorter = Math.max(TIMING.tickMs, Math.round(ms / 2 / TIMING.tickMs) * TIMING.tickMs);
                    const candidate = this.current.trace.map((item, position) => (position === index ? advance(shorter) : item));
                    const found = this.test(candidate);
                    yield;
                    if (!found) break;
                    const before = this.current;
                    this.current = found;
                    const kept = traceTransitions(found.trace) < traceTransitions(before.trace);
                    if (kept) {
                        this.steps.push({ actions: found.trace.length, transitions: traceTransitions(found.trace), note: `shortened a wait to ${(shorter / 1000).toFixed(1)} s` });
                        progress = true;
                    }
                    ms = shorter;
                    if (!this.current.trace[index] || !isTime(this.current.trace[index])) break;
                }
            }
        }
    }

    run({ sliceMs = Infinity, now = () => Date.now() } = {}) {
        const started = now();
        while (!this.done) {
            const next = this.work.next();
            if (next.done) { this.status = 'minimal'; break; }
            if (now() - started >= sliceMs) break;
        }
        return this.progress();
    }

    progress() {
        return {
            status: this.status,
            candidatesTried: this.tried,
            actions: this.current.trace.length,
            transitions: traceTransitions(this.current.trace),
            steps: this.steps.slice(),
        };
    }

    result() {
        const primary = this.current.violations.find((item) => item.invariant === this.target);
        return {
            status: this.status,
            target: this.target,
            original: { actions: this.original.actions, transitions: this.original.transitions },
            minimal: {
                trace: this.current.trace,
                actions: this.current.trace.length,
                transitions: traceTransitions(this.current.trace),
                violations: this.current.violations.map(({ entry, entryStartMs, ...rest }) => rest),
                primary: (({ entry, entryStartMs, ...rest }) => rest)(primary),
            },
            steps: this.steps,
            candidatesTried: this.tried,
        };
    }
}

/** Shrink to completion synchronously. */
function shrinkTrace(options) {
    const shrinker = new TraceShrinker(options);
    shrinker.run();
    return shrinker.result();
}

module.exports = { TraceShrinker, normalize, shrinkTrace };
