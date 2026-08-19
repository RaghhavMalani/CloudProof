'use strict';

const { EVENT_TYPES, createEvent, jsonSafe } = require('../protocol/events');
const { evaluateInvariants } = require('./invariants');

class FlightRecorder {
    constructor({ clock, seed = 1, runId = null, capacity = 25_000 } = {}) {
        if (!clock || typeof clock.now !== 'function') throw new TypeError('FlightRecorder requires a clock');
        this.clock = clock;
        this.seed = seed;
        this.startedAt = clock.now();
        this.runId = runId || `seed-${seed}-${this.startedAt}`;
        this.capacity = capacity;
        this.events = [];
        this.sequence = 0;
        this.dropped = 0;
        this.listeners = new Set();
        this.previousNodes = new Map();
        this.previousInvariants = new Map();
        this._detachNetwork = null;
        this.record(EVENT_TYPES.RUN_STARTED, { data: { seed } });
    }

    record(type, details = {}) {
        const event = createEvent({
            runId: this.runId,
            sequence: ++this.sequence,
            epochMs: this.clock.now(),
            startedAt: this.startedAt,
            type,
            ...details,
        });
        this.events.push(event);
        if (this.events.length > this.capacity) {
            this.events.shift();
            this.dropped += 1;
        }
        for (const listener of this.listeners) {
            try { listener(event); } catch (_) { /* observers never affect simulation */ }
        }
        return event;
    }

    subscribe(listener, { replay = false } = {}) {
        if (replay) for (const event of this.events) listener(event);
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    attachNetwork(network) {
        if (this._detachNetwork) this._detachNetwork();
        this._detachNetwork = network.observe((wire) => {
            const types = {
                send: EVENT_TYPES.RPC_SENT,
                reply: EVENT_TYPES.RPC_REPLY,
                delivered: EVENT_TYPES.RPC_DELIVERED,
                blocked: EVENT_TYPES.RPC_BLOCKED,
            };
            const type = types[wire.type];
            if (!type) return;
            this.record(type, {
                source: { component: 'network', nodeId: wire.from },
                subject: { kind: 'rpc', id: wire.rpcId, from: wire.from, to: wire.to },
                correlationId: wire.rpcId || null,
                data: wire,
            });
        });
        return this._detachNetwork;
    }

    captureCluster(cluster, { snapshot = true } = {}) {
        const states = cluster.states();
        for (const state of states) {
            const previous = this.previousNodes.get(state.replicaId);
            if (!previous || previous.state !== state.state) {
                this.record(EVENT_TYPES.NODE_ROLE_CHANGED, {
                    source: { component: 'raft', nodeId: state.replicaId },
                    subject: { kind: 'node', id: state.replicaId },
                    data: { from: previous?.state || null, to: state.state, term: state.term },
                });
            }
            if (!previous || previous.term !== state.term) {
                this.record(EVENT_TYPES.NODE_TERM_CHANGED, {
                    source: { component: 'raft', nodeId: state.replicaId },
                    subject: { kind: 'node', id: state.replicaId },
                    data: { from: previous?.term ?? null, to: state.term },
                });
            }
            if (previous && state.logLength > previous.logLength) {
                this.record(EVENT_TYPES.LOG_APPENDED, {
                    source: { component: 'raft', nodeId: state.replicaId },
                    subject: { kind: 'log', nodeId: state.replicaId },
                    data: { fromLength: previous.logLength, toLength: state.logLength },
                });
            }
            if (previous && state.commitIndex > previous.commitIndex) {
                this.record(EVENT_TYPES.LOG_COMMITTED, {
                    source: { component: 'raft', nodeId: state.replicaId },
                    subject: { kind: 'log', nodeId: state.replicaId, index: state.commitIndex },
                    data: { fromIndex: previous.commitIndex, toIndex: state.commitIndex, term: state.term },
                });
            }
            this.previousNodes.set(state.replicaId, jsonSafe(state));
        }

        if (snapshot) {
            this.record(EVENT_TYPES.CLUSTER_SNAPSHOT, {
                data: {
                    seed: cluster.seed,
                    leader: cluster.leader?.node?.replicaId || null,
                    nodes: states,
                    network: cluster.network.stats,
                    partitions: cluster.network.partitions.map((group) => [...group]),
                    crashed: [...cluster.network.crashed],
                },
            });
        }

        const invariants = evaluateInvariants(cluster);
        for (const invariant of invariants) {
            const previous = this.previousInvariants.get(invariant.id);
            const signature = JSON.stringify(invariant);
            if (previous !== signature) {
                this.record(EVENT_TYPES.INVARIANT_CHECKED, {
                    source: { component: 'invariant-checker' },
                    subject: { kind: 'invariant', id: invariant.id },
                    data: invariant,
                });
                this.previousInvariants.set(invariant.id, signature);
            }
        }
        return { states, invariants };
    }

    finish(data = {}) {
        return this.record(EVENT_TYPES.RUN_FINISHED, { data });
    }

    export() {
        return {
            schemaVersion: 1,
            runId: this.runId,
            seed: this.seed,
            startedAt: this.startedAt,
            eventCount: this.events.length,
            droppedEventCount: this.dropped,
            events: this.events.slice(),
        };
    }
}

module.exports = { FlightRecorder };
