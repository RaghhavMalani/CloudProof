'use strict';

/** Shared argument parsing for the raft-bench tools. */

function parseDuration(value) {
    if (typeof value === 'number') return value;
    const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(value).trim());
    if (!match) throw new Error(`cannot parse duration "${value}"`);
    const amount = Number(match[1]);
    const unit = match[2] || 's';
    return unit === 'ms' ? amount : unit === 's' ? amount * 1000 : amount * 60000;
}

function parseList(value, mapper = Number) {
    return String(value).split(',').map((s) => s.trim()).filter(Boolean).map(mapper);
}

/**
 * `--key value` and `--flag` parsing against a table of defaults. Durations
 * are keys listed in `durations`; lists in `lists`.
 */
function parseArgs(argv, defaults, { durations = [], lists = {}, flags = [], strings = [] } = {}) {
    const options = { ...defaults };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) throw new Error(`unexpected argument "${token}"`);
        const key = token.slice(2);
        if (flags.includes(key)) { options[key] = true; continue; }
        if (!Object.hasOwn(defaults, key)) throw new Error(`unknown option --${key}`);
        const value = argv[++i];
        if (value === undefined) throw new Error(`--${key} needs a value`);
        if (durations.includes(key)) options[key] = parseDuration(value);
        else if (lists[key]) options[key] = parseList(value, lists[key]);
        else if (strings.includes(key)) options[key] = value;
        else options[key] = Number.isNaN(Number(value)) ? value : Number(value);
    }
    return options;
}

module.exports = { parseArgs, parseDuration, parseList };
