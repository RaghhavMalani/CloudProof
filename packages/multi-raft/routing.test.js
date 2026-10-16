'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    STATES, compareKeys, ownsKey, checkDescriptors, staticDescriptors, RangeDirectory,
} = require('./descriptors');
const { RangeRouter, ClientSession, operationDigest, logicalRequestId } = require('./router');

const NODES = ['n1', 'n2', 'n3'];
const three = () => staticDescriptors({ boundaries: ['h', 'p'], replicas: NODES });

test('the static configuration is three ACTIVE ranges at epoch 1 covering the whole key space', () => {
    const descriptors = three();
    assert.deepEqual(descriptors.map((d) => [d.rangeId, d.startKey, d.endKey, d.epoch, d.state]), [
        ['r1', '', 'h', 1, STATES.ACTIVE],
        ['r2', 'h', 'p', 1, STATES.ACTIVE],
        ['r3', 'p', null, 1, STATES.ACTIVE],
    ]);
    assert.deepEqual(checkDescriptors(descriptors), { ok: true, violations: [] });
    assert.deepEqual(three(), descriptors, 'deterministic');
});

test('gaps, overlaps, duplicate ids, bad epochs and uncovered ends are all reported (I1-I4)', () => {
    const base = three();
    const gap = base.map((d) => (d.rangeId === 'r2' ? { ...d, startKey: 'i' } : d));
    assert.match(checkDescriptors(gap).violations.join(), /gap between r1 and r2/);
    const overlap = base.map((d) => (d.rangeId === 'r2' ? { ...d, startKey: 'g' } : d));
    assert.match(checkDescriptors(overlap).violations.join(), /overlap between r1 and r2/);
    const duplicate = base.map((d) => (d.rangeId === 'r3' ? { ...d, rangeId: 'r2' } : d));
    assert.match(checkDescriptors(duplicate).violations.join(), /rangeId r2 is not unique/);
    const badEpoch = base.map((d) => (d.rangeId === 'r1' ? { ...d, epoch: 0 } : d));
    assert.match(checkDescriptors(badEpoch).violations.join(), /epoch 0 is not a positive integer/);
    assert.match(checkDescriptors(base.slice(1)).violations.join(), /gap before r2/);
    assert.match(checkDescriptors(base.slice(0, 2)).violations.join(), /gap after r2/);
    const inverted = base.map((d) => (d.rangeId === 'r2' ? { ...d, endKey: 'a' } : d));
    assert.match(checkDescriptors(inverted).violations.join(), /inverted interval/);
    // A non-ACTIVE descriptor neither covers nor overlaps.
    const fenced = base.map((d) => (d.rangeId === 'r2' ? { ...d, state: STATES.FENCED } : d));
    assert.match(checkDescriptors(fenced).violations.join(), /gap between r1 and r3/);
    assert.throws(() => new RangeDirectory(gap), /invalid range descriptors/);
});

test('lookup honours half-open bounds, the empty smallest key and +infinity', () => {
    const directory = new RangeDirectory(three());
    const owner = (key) => directory.lookup(key).rangeId;
    assert.equal(owner(''), 'r1');
    assert.equal(owner('apple'), 'r1');
    assert.equal(owner('gzzzz'), 'r1');
    assert.equal(owner('h'), 'r2', 'a boundary key belongs to the range it starts');
    assert.equal(owner('orange'), 'r2');
    assert.equal(owner('p'), 'r3');
    assert.equal(owner('pear'), 'r3');
    assert.equal(owner('\u{10FFFF}'), 'r3');
    assert.throws(() => directory.lookup(7), /key must be a string/);
});

test('keys compare as UTF-8 bytes, not UTF-16 code units', () => {
    // UTF-16 puts a surrogate pair (U+10000) before U+FFFF; UTF-8 bytes do not.
    assert.ok('\u{10000}' < '￿', 'JavaScript string order');
    assert.ok(compareKeys('\u{10000}', '￿') > 0, 'byte order');
    const directory = new RangeDirectory(staticDescriptors({ boundaries: ['￿'], replicas: NODES }));
    assert.equal(directory.lookup('\u{10000}').rangeId, 'r2');
});

test('every key maps to exactly one ACTIVE range (I1), checked against brute force', () => {
    const descriptors = staticDescriptors({ boundaries: ['k20000', 'k40000', 'k60000', 'k80000'], replicas: NODES });
    const directory = new RangeDirectory(descriptors);
    let x = 0x2545f491;
    for (let i = 0; i < 5000; i += 1) {
        x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        const key = `k${String(x % 100000).padStart(5, '0')}`;
        const owners = descriptors.filter((d) => ownsKey(d, key));
        assert.equal(owners.length, 1, key);
        assert.equal(directory.lookup(key).rangeId, owners[0].rangeId, key);
    }
});

test('the directory is immutable', () => {
    const directory = new RangeDirectory(three());
    const r1 = directory.get('r1');
    assert.throws(() => { r1.epoch = 2; }, TypeError);
    assert.throws(() => { r1.replicas.push('n4'); }, TypeError);
    assert.equal(directory.get('nope'), null);
});

test('a routed request carries the owning range, its epoch and the logical request id', () => {
    const router = new RangeRouter({ directory: new RangeDirectory(three()) });
    const session = new ClientSession('client-a');
    const request = router.request({ ...session.next(), op: 'set', key: 'orange', value: 'v' });
    assert.deepEqual(request, {
        rangeId: 'r2', expectedRangeEpoch: 1, clientId: 'client-a', seqNo: 1, key: 'orange', op: 'set', value: 'v',
    });
    assert.equal(logicalRequestId(request), 'client-a#1');
    assert.equal(session.next().seqNo, 2, 'a new logical request never reuses a seqNo');
    assert.throws(() => router.request({ clientId: '', seqNo: 1, op: 'set', key: 'a' }), /clientId/);
    assert.throws(() => router.request({ clientId: 'c', seqNo: 0, op: 'set', key: 'a' }), /seqNo/);
});

test('the operation digest is canonical and separates different operations', () => {
    const a = operationDigest({ op: 'set', key: 'k', value: 1 });
    assert.equal(a, operationDigest({ key: 'k', value: 1, op: 'set' }));
    assert.notEqual(a, operationDigest({ op: 'set', key: 'k', value: 2 }));
    assert.notEqual(a, operationDigest({ op: 'delete', key: 'k' }));
    assert.match(a, /^[0-9a-f]{64}$/);
});
