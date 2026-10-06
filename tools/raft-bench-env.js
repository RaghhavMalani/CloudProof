#!/usr/bin/env node
'use strict';

/**
 * raft-bench-env.js — records the benchmark machine (Step 0 of Phase IV-A).
 *
 *   node tools/raft-bench-env.js --out artifacts/perf/phase-iv-a/baseline-environment.json
 */

const fs = require('fs');
const path = require('path');
const { captureEnvironment } = require('../packages/raft-bench/environment');
const { parseArgs } = require('../packages/raft-bench/cli');

const ROOT = path.join(__dirname, '..');
const options = parseArgs(process.argv.slice(2), {
    out: null,
    'data-dir': path.join(ROOT, '.bench-data', 'cluster'),
}, { strings: ['out', 'data-dir'] });

const environment = captureEnvironment({ root: ROOT, dataDir: options['data-dir'] });
const text = `${JSON.stringify(environment, null, 2)}\n`;
if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, text);
}
process.stdout.write(options.out ? `environment -> ${options.out}\n` : text);
