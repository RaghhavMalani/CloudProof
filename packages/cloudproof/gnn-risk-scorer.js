'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { stable } = require('./state');

function riskScorerKey(state, candidateAction) {
    if (!state || !candidateAction) throw new TypeError('state and candidate action are required');
    return crypto.createHash('sha256')
        .update(JSON.stringify(stable({ state, action: candidateAction })))
        .digest('hex');
}

class OfflineGnnRiskScorer {
    constructor(rows) {
        this.scores = new Map();
        for (const row of rows) {
            if (typeof row?.key !== 'string' || !Number.isFinite(row.risk)
                || row.risk < 0 || row.risk > 1 || !Number.isFinite(row.uncertainty)
                || row.uncertainty < 0) {
                throw new TypeError('invalid offline GNN score row');
            }
            if (this.scores.has(row.key)) throw new TypeError(`duplicate GNN score key: ${row.key}`);
            this.scores.set(row.key, { risk: row.risk, uncertainty: row.uncertainty });
        }
        if (this.scores.size === 0) throw new TypeError('at least one offline GNN score is required');
    }

    scoreWithUncertainty(state, candidateAction) {
        const key = riskScorerKey(state, candidateAction);
        const value = this.scores.get(key);
        if (!value) throw new Error(`missing offline GNN score for ${key}`);
        return value;
    }

    score(state, candidateAction) {
        return this.scoreWithUncertainty(state, candidateAction).risk;
    }

    static fromJsonl(file) {
        const rows = fs.readFileSync(file, 'utf8').split('\n')
            .filter(Boolean).map((line) => JSON.parse(line));
        return new OfflineGnnRiskScorer(rows);
    }
}

module.exports = { OfflineGnnRiskScorer, riskScorerKey };
