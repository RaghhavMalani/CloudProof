'use strict';

/**
 * manual-network.js — a network a test drives by hand.
 *
 * Every RPC waits in `pending` until the test delivers it, in whatever order
 * it chooses, to a real RaftNode. That makes reordering, duplication, loss and
 * late replies explicit test steps instead of probabilities.
 */

const turn = () => new Promise((resolve) => setImmediate(resolve));

const ROUTES = {
    '/append-entries': 'handleAppendEntries',
    '/request-vote': 'handleRequestVote',
    '/pre-vote': 'handlePreVote',
};

class ManualNetwork {
    constructor() { this.pending = []; this.nodes = new Map(); this.sent = []; }

    register(url, node) { this.nodes.set(url, node); }

    transport() {
        return {
            post: (url, body) => new Promise((resolve, reject) => {
                const parsed = new URL(url);
                const message = {
                    target: parsed.origin,
                    route: parsed.pathname,
                    body: JSON.parse(JSON.stringify(body)),
                    resolve,
                    reject,
                };
                this.pending.push(message);
                this.sent.push(message);
            }),
        };
    }

    to(target) { return this.pending.filter((m) => m.target === target); }

    async deliver(message, { dropReply = false } = {}) {
        this.pending.splice(this.pending.indexOf(message), 1);
        const node = this.nodes.get(message.target);
        const data = await node[ROUTES[message.route]](message.body);
        if (!dropReply) message.resolve({ data });
        await turn();
        return data;
    }

    async deliverAll(target, { rounds = 50 } = {}) {
        for (let i = 0; i < rounds && this.to(target).length; i += 1) await this.deliver(this.to(target)[0]);
    }

    fail(message) {
        this.pending.splice(this.pending.indexOf(message), 1);
        message.reject(new Error('ETIMEDOUT'));
    }
}

module.exports = { ManualNetwork, turn };
