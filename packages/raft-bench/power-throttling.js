'use strict';

/**
 * power-throttling.js — opt benchmark processes out of Windows power
 * throttling (EcoQoS), and prove it took effect.
 *
 * Windows 11 throttles a busy process that has no foreground window about
 * three seconds after it gets busy: it lowers the core's clock and prefers
 * efficiency cores. On the benchmark laptop a pure CPU loop runs about 4.3x
 * slower after the cliff, for the rest of the process's life; every replica
 * and load generator the harness starts is such a process (methodology
 * amendment 2). SetProcessInformation(ProcessPowerThrottling) with
 * EXECUTION_SPEED controlled and off is the per-process switch behind Task
 * Manager's "Efficiency mode". It changes no system-wide setting and affects
 * only the processes it is given. The helper reads the policy back with
 * GetProcessInformation, so `applied` is what Windows reports, not what was
 * asked for.
 *
 * Policies: 'disabled' (opt out; the Phase IV-A comparison) or 'os-default'
 * (leave Windows' behaviour; the historical baseline and the control arm).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'tools', 'windows', 'disable-power-throttling.ps1');
const MECHANISM = 'SetProcessInformation(ProcessPowerThrottling, ControlMask=EXECUTION_SPEED, StateMask=0), verified with GetProcessInformation';
const POLICIES = Object.freeze(['disabled', 'os-default']);

class PowerPolicyError extends Error {}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Identity of the code that implements the opt-out, for the trial record. */
function helperIdentity() {
    return {
        mechanism: MECHANISM,
        script: 'tools/windows/disable-power-throttling.ps1',
        scriptSha256: process.platform === 'win32' ? sha256(SCRIPT) : null,
        module: 'packages/raft-bench/power-throttling.js',
        moduleSha256: sha256(__filename),
    };
}

function parseLine(line) {
    const match = /^(\d+) set=(\w+) read=(\w+) control=(\d+) state=(\d+) error=(\d+)/.exec(line.trim());
    if (!match) return null;
    const control = Number(match[4]);
    const state = Number(match[5]);
    const read = match[3] === 'True';
    return {
        pid: Number(match[1]),
        set: match[2] === 'True',
        read,
        controlMask: control,
        stateMask: state,
        error: Number(match[6]),
        // Execution-speed throttling is explicitly controlled, and off.
        applied: read && (control & 0x1) === 0x1 && (state & 0x1) === 0,
    };
}

function runHelper(pids, { queryOnly = false, reset = false } = {}) {
    const list = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
    if (!list.length) return [];
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ProcessIds', list.join(',')];
    if (queryOnly) args.push('-QueryOnly');
    if (reset) args.push('-Reset');
    const output = execFileSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true });
    const byPid = new Map(output.split(/\r?\n/).map(parseLine).filter(Boolean).map((r) => [r.pid, r]));
    return list.map((pid) => byPid.get(pid) || { pid, set: false, read: false, controlMask: 0, stateMask: 0, error: -1, applied: false });
}

/** Opts the pids out; returns one verified result per pid. No-op off Windows. */
function disablePowerThrottling(pids) {
    if (process.platform !== 'win32') return pids.map((pid) => ({ pid, applied: null, platform: process.platform }));
    return runHelper(pids);
}

/** Hands the pids back to Windows' own power management (the default policy). */
function resetPowerThrottling(pids) {
    if (process.platform !== 'win32') return pids.map((pid) => ({ pid, applied: null, platform: process.platform }));
    return runHelper(pids, { reset: true });
}

/** Reads the current policy of the pids without changing it. */
function queryPowerThrottling(pids) {
    if (process.platform !== 'win32') return pids.map((pid) => ({ pid, applied: null, platform: process.platform }));
    return runHelper(pids, { queryOnly: true });
}

/**
 * Applies `policy` to labelled processes ([{ role, pid }]) and returns the
 * record a trial carries, verified per process from what Windows reports:
 * 'disabled' requires execution-speed throttling controlled and off;
 * 'os-default' hands each process back to the system (ControlMask 0) and
 * requires that. A process not in the requested state is a PowerPolicyError:
 * the benchmark stops rather than run a mixed environment. Off Windows the
 * policy does not exist and is recorded as not applicable.
 */
function applyPolicy(policy, processes) {
    if (!POLICIES.includes(policy)) throw new PowerPolicyError(`unknown power-throttling policy ${policy}`);
    const record = { requested: policy, platform: process.platform, ...helperIdentity(), processes: [] };
    if (process.platform !== 'win32') {
        record.applied = 'not-applicable';
        record.processes = processes.map(({ role, pid }) => ({ role, pid }));
        return record;
    }
    const pids = processes.map((p) => p.pid);
    const results = policy === 'disabled' ? disablePowerThrottling(pids) : resetPowerThrottling(pids);
    const inState = (r) => (policy === 'disabled' ? r.applied === true : r.read && (r.controlMask & 0x1) === 0);
    record.processes = processes.map(({ role }, i) => ({ role, ...results[i], inRequestedState: inState(results[i]) }));
    record.applied = record.processes.every((p) => p.inRequestedState);
    if (!record.applied) {
        const failed = record.processes.filter((p) => !p.inRequestedState).map((p) => `${p.role}(pid ${p.pid}, error ${p.error})`);
        const error = new PowerPolicyError(`power policy ${policy} could not be verified for ${failed.join(', ')}`);
        error.record = record;
        throw error;
    }
    return record;
}

module.exports = {
    POLICIES, MECHANISM, PowerPolicyError, applyPolicy, disablePowerThrottling, resetPowerThrottling, queryPowerThrottling,
    helperIdentity, parseLine,
};
