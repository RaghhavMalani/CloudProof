#!/usr/bin/env node
'use strict';

// Writes the committed relational-only counterfactual fixture: the first pair
// of every relational-only family under the default pair seed. The Python
// tests tensorize both members and prove the pooled MLP receives identical
// inputs; the Node tests prove regenerating the file is byte-identical.

const fs = require('node:fs');
const path = require('node:path');
const { RELATIONAL_ONLY_FAMILIES } = require('../packages/cloudproof/counterfactual-pairs');
const { TOPOLOGY_CATALOG_V2 } = require('../packages/cloudproof/topology');
const { PAIR_FAMILY_MIX, executeCounterfactualPair } = require('../sim/cloud-causal-corpus');

const FIXTURE = path.join('artifacts', 'cloudproof', 'datasets', 'relational-pairs-95000.jsonl');

async function buildFixtureLines() {
    const lines = [];
    // First feasible, valid pair of each family inside that family's slot.
    for (const family of RELATIONAL_ONLY_FAMILIES) {
        const slot = PAIR_FAMILY_MIX.indexOf(family);
        let chosen = null;
        for (let offset = 0; offset < TOPOLOGY_CATALOG_V2.length && !chosen; offset += 1) {
            const pair = await executeCounterfactualPair(slot * TOPOLOGY_CATALOG_V2.length + offset, {});
            if (pair.summary.family !== family) throw new Error(`fixture slot mismatch for ${family}`);
            if (pair.summary.valid && pair.summary.infeasibleReason === null) chosen = pair;
        }
        if (!chosen) throw new Error(`no feasible ${family} pair in the first catalog cycle`);
        lines.push(...chosen.lines);
    }
    return lines;
}

async function main() {
    const lines = await buildFixtureLines();
    const target = path.resolve(FIXTURE);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ file: target, records: lines.length })}\n`);
}

if (require.main === module) void main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});

module.exports = { FIXTURE, buildFixtureLines };
