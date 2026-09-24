#!/usr/bin/env node
'use strict';

/**
 * cloudproof-ops — the Operations Console verifier, from a terminal.
 *
 *   node tools/cloudproof-ops.js demos
 *   node tools/cloudproof-ops.js verify --demo rollout-payment [--max-unavailable 0] [--budget standard] [--seed 1337] [--max-faults 1]
 *   node tools/cloudproof-ops.js export --demo rollout-payment --out bundle.json
 *   node tools/cloudproof-ops.js check bundle.json [--rerun]
 *
 * `check` is how an evidence bundle exported from the browser is re-verified:
 * the digests are SHA-256 over canonical JSON in both places.
 */

const fs = require('fs');
const path = require('path');
const ops = require('../packages/cloudproof-ops');

function parseArgs(argv) {
    const args = { _: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) { args._.push(token); continue; }
        const key = token.slice(2);
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) args[key] = true;
        else { args[key] = next; index += 1; }
    }
    return args;
}

function configFor(args) {
    const demo = ops.demoById(args.demo || 'rollout-payment');
    if (!demo) throw new Error(`unknown demo: ${args.demo}; try \`demos\``);
    const scenario = ops.loadScenario(demo.scenario);
    const change = { ...demo.change };
    if (args['max-unavailable'] !== undefined) change.maxUnavailable = Number(args['max-unavailable']);
    if (args['max-surge'] !== undefined) change.maxSurge = Number(args['max-surge']);
    const config = {
        scenarioId: scenario.id,
        world: scenario.world,
        versions: scenario.versions,
        labels: scenario.labels,
        change,
        invariants: scenario.invariants,
        faults: demo.faults,
        maxFaults: Number(args['max-faults'] || 1),
        seed: Number(args.seed || 1337),
        budget: args.budget ? (Number.isFinite(Number(args.budget)) ? Number(args.budget) : args.budget) : demo.budget,
    };
    return { demo, scenario, config };
}

function runVerification(args) {
    const { scenario, config } = configFor(args);
    const started = Date.now();
    const result = ops.verifyChange(config);
    let shrink = null;
    if (result.counterexample) {
        const counterexample = result.counterexample;
        shrink = ops.shrinkTrace({ world: counterexample.world, trace: counterexample.trace, invariants: config.invariants, target: counterexample.primary.invariant });
    }
    return { scenario, config, result, shrink, elapsedMs: Date.now() - started };
}

function printResult({ config, result, shrink, elapsedMs }) {
    console.log(`${ops.changeSummary(config.change)}`);
    console.log(`faults: ${config.faults.join(', ')} · fault budget ${config.maxFaults} · seed ${config.seed} · ${elapsedMs} ms`);
    console.log(`status: ${result.status} after ${result.counters.schedulesChecked} schedules (${result.counters.transitions} transitions, ${result.counters.uniqueStates} unique states)`);
    if (result.counterexample) {
        const counterexample = result.counterexample;
        console.log(`counterexample #${counterexample.scheduleIndex}: ${counterexample.label}`);
        console.log(`  ${counterexample.primary.invariant}: expected ${counterexample.primary.expected}, observed ${counterexample.primary.observed} at T+${(counterexample.atMs / 1000).toFixed(1)} s`);
        console.log(`  shrunk: ${shrink.steps.map((item) => item.actions).join(' → ')} actions`);
        for (const entry of shrink.minimal.trace) console.log(`    ${String(entry.atMs).padStart(6)} ms  ${entry.origin.padEnd(6)} ${entry.label || JSON.stringify(entry.action)}`);
    }
    if (result.counters.preExisting) console.log(`pre-existing risks (fail without the change too): ${result.counters.preExisting}`);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const command = args._[0];
    if (command === 'demos') {
        for (const demo of ops.DEMOS) console.log(`${demo.id.padEnd(18)} ${demo.title} — ${demo.caption}`);
        return 0;
    }
    if (command === 'verify') {
        const run = runVerification(args);
        printResult(run);
        return 0;
    }
    if (command === 'export') {
        const run = runVerification(args);
        const bundle = ops.evidence.buildEvidence({
            scenario: run.scenario, config: run.config, result: run.result, shrink: run.shrink,
            exportedAt: args['exported-at'] || new Date().toISOString(),
        });
        const text = `${JSON.stringify(bundle, null, 2)}\n`;
        if (args.out) {
            fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
            fs.writeFileSync(args.out, text);
            console.log(`wrote ${args.out} (${bundle.digests.bundle.slice(0, 16)})`);
        } else {
            process.stdout.write(text);
        }
        return 0;
    }
    if (command === 'check') {
        const file = args._[1];
        if (!file) throw new Error('usage: check <bundle.json> [--rerun]');
        const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
        const verdict = ops.evidence.verifyEvidence(bundle, { rerunSearch: Boolean(args.rerun) });
        for (const item of verdict.checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? ` (${item.detail})` : ''}`);
        console.log(verdict.ok ? `bundle ${bundle.digests.bundle.slice(0, 16)} verified` : 'bundle did NOT verify');
        return verdict.ok ? 0 : 1;
    }
    console.error('usage: cloudproof-ops.js demos | verify --demo <id> | export --demo <id> [--out file] | check <bundle.json> [--rerun]');
    return 2;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { configFor, parseArgs };
