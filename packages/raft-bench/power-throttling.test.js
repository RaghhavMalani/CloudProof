const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { applyPolicy, parseLine, PowerPolicyError, helperIdentity } = require('./power-throttling');

const windows = process.platform === 'win32';

test('a helper line is applied only when execution-speed throttling is controlled and off', () => {
    assert.equal(parseLine('42 set=True read=True control=1 state=0 error=0').applied, true);
    assert.equal(parseLine('42 set=True read=True control=0 state=0 error=0').applied, false, 'system-managed is not opted out');
    assert.equal(parseLine('42 set=True read=True control=1 state=1 error=0').applied, false, 'controlled and on is throttled');
    assert.equal(parseLine('42 set=False read=False control=0 state=0 error=87').applied, false);
    assert.equal(parseLine('garbage'), null);
});

test('an unknown policy is refused', () => {
    assert.throws(() => applyPolicy('maybe', [{ role: 'x', pid: process.pid }]), PowerPolicyError);
});

test('the record names the mechanism and the hash of the code that applied it', () => {
    const identity = helperIdentity();
    assert.match(identity.mechanism, /ProcessPowerThrottling/);
    assert.match(identity.moduleSha256, /^[0-9a-f]{64}$/);
});

test('off Windows the policy is recorded as not applicable', { skip: windows }, () => {
    const record = applyPolicy('disabled', [{ role: 'self', pid: process.pid }]);
    assert.equal(record.applied, 'not-applicable');
});

test('on Windows both policies are applied and verified per process', { skip: !windows }, () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    try {
        const off = applyPolicy('disabled', [{ role: 'child', pid: child.pid }]);
        assert.equal(off.applied, true);
        assert.equal(off.processes[0].controlMask & 1, 1);
        assert.equal(off.processes[0].stateMask & 1, 0);
        const def = applyPolicy('os-default', [{ role: 'child', pid: child.pid }]);
        assert.equal(def.applied, true);
        assert.equal(def.processes[0].controlMask & 1, 0, 'handed back to the system');
    } finally {
        child.kill();
    }
});

test('on Windows a process the policy cannot reach stops the benchmark', { skip: !windows }, () => {
    assert.throws(() => applyPolicy('disabled', [{ role: 'gone', pid: 999999 }]), (error) => error instanceof PowerPolicyError
        && /could not be verified/.test(error.message) && error.record.applied === false);
});
