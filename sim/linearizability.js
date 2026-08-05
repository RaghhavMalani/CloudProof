/**
 * linearizability.js — machine-checks a concurrent history.
 *
 * ── What linearizability actually requires ───────────────────────────────────
 * A history is linearizable if you can pick, for every operation, a single
 * instant between its invocation and its response at which it "took effect",
 * such that (a) the resulting sequential order produces exactly the return
 * values that were observed, and (b) operations that did not overlap in real
 * time keep their real-time order.
 *
 * That second clause is what makes it strictly stronger than sequential
 * consistency, and it is the property a client actually cares about: if a write
 * completed before a read started, the read must see it. No amount of unit
 * testing establishes this — it is a statement about *all* possible
 * interleavings, and it is checked, not asserted.
 *
 * ── Why this is hard, and how the search stays tractable ─────────────────────
 * Concurrent operations may be linearized in any order, so the naive search is
 * a permutation explosion. Two things tame it:
 *
 *   1. Wing & Gong's incremental search. Rather than enumerating orders, walk
 *      the history from the front and try to "lift" each operation that is
 *      currently at the head of some concurrent group. If the model accepts it,
 *      recurse on the rest; if the recursion fails, put it back and try the
 *      next. Failure prunes an entire subtree.
 *
 *   2. Memoisation on (set of already-linearized operations, model state). The
 *      same reachable configuration is arrived at by many different orders, and
 *      revisiting it can only fail again.
 *
 * ── The interesting case: operations with no response ────────────────────────
 * A client whose request times out does not know whether it happened. The
 * checker must consider both: such an operation may be linearized anywhere
 * after its invocation, *or* not at all. Ignoring them makes the checker
 * unsound — a write that silently took effect and was later observed would be
 * reported as a violation of a history that is actually fine. Forcing them to
 * linearize makes it produce false alarms the other way. Both branches are
 * explored below.
 */

/**
 * @typedef {{ process:number, type:'invoke'|'ok'|'fail'|'info', op:object, at:number }} Event
 */

/**
 * A key-value register: write, read, compare-and-swap, delete.
 *
 * State is a plain object so it serialises cheaply for the memo key. Every
 * transition returns whether the *observed* result is consistent with applying
 * this operation here — that check is the entire point, and returning `false`
 * is what prunes the search.
 */
const registerModel = {
    init: () => ({}),

    /**
     * @returns {{ok:boolean, state?:object}} ok=false means this operation
     * cannot have taken effect at this position in the order.
     */
    apply(state, op) {
        switch (op.kind) {
            case 'write': {
                if (op.result !== undefined && op.result !== true) return { ok: false };
                return { ok: true, state: { ...state, [op.key]: op.value } };
            }
            case 'read': {
                const actual = state[op.key] ?? null;
                // A pending read (unknown result) constrains nothing.
                if (op.result === undefined) return { ok: true, state };
                return actual === op.result ? { ok: true, state } : { ok: false };
            }
            case 'cas': {
                const current = state[op.key] ?? null;
                const succeeds = current === op.expected;
                if (op.result !== undefined && op.result !== succeeds) return { ok: false };
                return succeeds
                    ? { ok: true, state: { ...state, [op.key]: op.value } }
                    : { ok: true, state };
            }
            case 'delete': {
                const next = { ...state };
                delete next[op.key];
                return { ok: true, state: next };
            }
            default:
                return { ok: false };
        }
    },

    // Sorted so two states with the same contents hash identically regardless
    // of insertion order — otherwise the memo almost never hits.
    hash: (state) => JSON.stringify(Object.keys(state).sort().map((k) => [k, state[k]])),
};

class LinearizabilityChecker {
    constructor(model = registerModel, { maxSteps = 2_000_000 } = {}) {
        this.model = model;
        this.maxSteps = maxSteps;
    }

    /**
     * @param {Event[]} history
     * @returns {{linearizable:boolean, steps:number, checked:number, reason?:string, witness?:object[]}}
     */
    check(history) {
        const operations = this._pair(history);
        if (operations.length === 0) return { linearizable: true, steps: 0, checked: 0 };

        const memo = new Set();
        const witness = [];
        let steps = 0;
        let exhausted = false;

        const search = (remaining, state) => {
            if (steps > this.maxSteps) { exhausted = true; return false; }
            steps += 1;

            // Success once nothing is left that *must* be placed. Operations
            // that never returned are allowed to remain unplaced — the client
            // never learned whether they happened, so a linearization in which
            // they did not is a valid explanation.
            if (remaining.every((op) => op.pending)) return true;

            const key = `${remaining.map((o) => o.id).join(',')}|${this.model.hash(state)}`;
            if (memo.has(key)) return false;
            memo.add(key);

            for (let i = 0; i < remaining.length; i += 1) {
                const candidate = remaining[i];

                // Real-time order: an operation cannot be linearized before one
                // that *returned* strictly before this one was invoked. Skipping
                // this check is the classic mistake that turns a linearizability
                // checker into a sequential-consistency checker.
                let blocked = false;
                for (let j = 0; j < i; j += 1) {
                    if (!remaining[j].pending && remaining[j].returnedAt < candidate.invokedAt) {
                        blocked = true;
                        break;
                    }
                }
                if (blocked) break;

                const outcome = this.model.apply(state, candidate.op);
                if (!outcome.ok) continue;

                witness.push(candidate);
                const rest = remaining.slice(0, i).concat(remaining.slice(i + 1));
                if (search(rest, outcome.state)) return true;
                witness.pop();
            }

            return false;
        };

        const linearizable = search(operations, this.model.init());
        return {
            linearizable,
            steps,
            checked: operations.length,
            exhausted,
            reason: linearizable
                ? undefined
                : exhausted
                    ? `search budget exhausted after ${steps} steps — inconclusive, not a violation`
                    : 'no ordering of the concurrent operations reproduces the observed results',
            witness: linearizable ? witness.map((o) => o.op) : undefined,
        };
    }

    /** Matches invocations to their completions and folds the result in. */
    _pair(history) {
        const open = new Map();
        const operations = [];
        let id = 0;

        for (const event of history) {
            if (event.type === 'invoke') {
                const record = {
                    id: id++,
                    process: event.process,
                    op: { ...event.op },
                    invokedAt: event.at,
                    returnedAt: Infinity,
                    pending: true,
                };
                open.set(event.process, record);
                operations.push(record);
                continue;
            }

            const record = open.get(event.process);
            if (!record) continue;
            open.delete(event.process);

            if (event.type === 'ok') {
                record.pending = false;
                record.returnedAt = event.at;
                if (event.op && 'result' in event.op) record.op.result = event.op.result;
            } else if (event.type === 'fail') {
                // A definitive failure — the server said no. It did not happen,
                // so it is removed from consideration entirely.
                operations.splice(operations.indexOf(record), 1);
            }
            // 'info' leaves it pending: the outcome is genuinely unknown.
        }

        return operations.sort((a, b) => a.invokedAt - b.invokedAt || a.id - b.id);
    }
}

/**
 * Records a history from a live or simulated client.
 *
 * Deliberately minimal and separate from the checker: a recorder that knew
 * about the model could omit the very information a violation depends on.
 */
class HistoryRecorder {
    constructor(clock) {
        this.clock = clock;
        this.events = [];
    }

    invoke(process, op) {
        this.events.push({ process, type: 'invoke', op, at: this.clock.now() });
    }

    ok(process, result) {
        this.events.push({ process, type: 'ok', op: { result }, at: this.clock.now() });
    }

    fail(process) {
        this.events.push({ process, type: 'fail', op: {}, at: this.clock.now() });
    }

    /** Outcome unknown — a timeout. The checker must consider both branches. */
    info(process) {
        this.events.push({ process, type: 'info', op: {}, at: this.clock.now() });
    }

    summary() {
        const counts = { invoke: 0, ok: 0, fail: 0, info: 0 };
        for (const event of this.events) counts[event.type] += 1;
        return counts;
    }
}

module.exports = { LinearizabilityChecker, HistoryRecorder, registerModel };
