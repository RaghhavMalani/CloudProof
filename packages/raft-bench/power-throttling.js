'use strict';

/**
 * power-throttling.js — opt benchmark processes out of Windows power
 * throttling (EcoQoS).
 *
 * Windows 11 throttles a busy process that has no foreground window after
 * about three seconds: it lowers the core's clock and prefers efficiency
 * cores. On the benchmark laptop a pure CPU loop runs about 4.6x slower after
 * the cliff, for the rest of the process's life; every replica and load
 * generator the harness starts is such a process. SetProcessInformation(
 * ProcessPowerThrottling) with EXECUTION_SPEED controlled and off is the
 * per-process switch behind Task Manager's "Efficiency mode": it changes no
 * system setting and affects only the processes it is given.
 *
 * No-op on other platforms. Returns { pid: applied } for each pid.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'tools', 'windows', 'disable-power-throttling.ps1');

function disablePowerThrottling(pids) {
    const list = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
    if (process.platform !== 'win32' || !list.length) return Object.fromEntries(list.map((pid) => [pid, null]));
    const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
        '-ProcessIds', list.join(',')], { encoding: 'utf8', windowsHide: true });
    const result = {};
    for (const line of output.split(/\r?\n/)) {
        const [pid, ok] = line.trim().split(/\s+/);
        if (pid) result[Number(pid)] = ok === 'True';
    }
    return result;
}

module.exports = { disablePowerThrottling };
