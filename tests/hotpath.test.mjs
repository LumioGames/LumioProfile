import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfiler } from '../packages/profile/src/core.ts';

function fixture() {
  let clocks = 0, timers = 0;
  const host = { contract: 'lumio.observation/1' };
  const p = createProfiler({ host, sourceId: 'hotpath', role: 'test', build: { id: 'test', mode: 'release', codeEpoch: '1' },
    markers: [{ id: 1, name: 'event', kind: 'event', fields: ['a', 'b', 'c', 'd'] },
      { id: 17, name: 'counter', kind: 'counter' }, { id: 200000, name: 'gauge', kind: 'gauge' },
      { id: 8, name: 'histogram', kind: 'histogram', buckets: [0, 5] }],
    policy: { allowRelease: true, maxOpenSpans: 1 },
    clock: { id: 'clock', epoch: '1', unit: 'ms', now: () => { clocks++; return 0; } },
    scheduler: { set: () => ++timers, clear: () => { timers--; } } });
  function start(mode, extra = {}) {
    const plan = p.prepare({ mode, durationMs: 1000, maxBytes: 16384, ...extra });
    assert.equal(plan.ok, true); assert.equal(p.start({ token: plan.token, requestId: plan.token, captureId: plan.token }).ok, true);
  }
  return { p, host, start, clocks: () => clocks, timers: () => timers };
}

test('Stats preserves sparse marker IDs, kinds, filtering and histogram boundaries without clocks', () => {
  const f = fixture(); f.start('stats', { markerIds: [17, 200000, 8] });
  const before = f.clocks(), w = f.host.stats;
  for (let i = 0; i < 100; i++) { w.add(17, 2); w.gauge(200000, i); w.observe(8, [-1, 0, 5, 6][i % 4]); }
  w.add(8, 9); w.add(17, NaN); w.add(1, 1);
  assert.equal(f.clocks(), before);
  const s = f.p.status();
  assert.equal(s.stats.find(v => v.markerId === 17).value, 200);
  assert.equal(s.stats.find(v => v.markerId === 200000).value, 99);
  assert.deepEqual(s.stats.find(v => v.markerId === 8).buckets, [50, 25, 25]);
  assert.equal(s.quality.invalid, 2);
  f.p.stop(); f.p.release();
  const stopped = f.clocks(); w.add(17, 1);
  assert.equal(f.clocks(), stopped); assert.equal(f.timers(), 0);
});

test('ring reuse and invalid partial writes cannot leak previous text into empty events', () => {
  const f = fixture(); f.start('trace', { overflowPolicy: 'overwrite-oldest-chunk' });
  const w = f.host.trace;
  for (let i = 0; i < 40; i++) w.event(1, { operationKey: 'operation', entityKey: 'entity', fields: { a: 'old', b: 12, c: true, d: 'last' } });
  w.event(1, { operationKey: 'partial', entityKey: 'x'.repeat(96) });
  for (let i = 0; i < 40; i++) w.event(1);
  f.p.stop();
  const s = f.p.snapshot();
  assert.equal(s.quality.invalid, 1);
  assert.ok(s.quality.overwritten > 0);
  for (const r of s.records) {
    assert.equal(r.context.operationKey, undefined); assert.equal(r.context.entityKey, undefined);
    assert.equal(r.context.fields, undefined); assert.equal(r.correlationKey, undefined);
  }
});

test('full drop-new and stopped stale writers perform no further capture clock work', () => {
  const f = fixture(); f.start('trace'); const w = f.host.trace;
  for (let i = 0; i < 100; i++) w.event(1);
  const full = f.clocks();
  for (let i = 0; i < 1000; i++) w.event(1, { tick: i });
  assert.equal(f.clocks(), full);
  f.p.stop(); f.p.release(); const stopped = f.clocks();
  for (let i = 0; i < 1000; i++) w.event(1);
  assert.equal(f.clocks(), stopped); assert.equal(f.p.status().allocatedBytes, 0);
});

test('maximum Stats catalog stays inside its reserved storage budget', () => {
  const host = { contract: 'lumio.observation/1' };
  const p = createProfiler({ host, sourceId: 'maximum-stats', role: 'test', build: { id: 'test', mode: 'debug', codeEpoch: '1' },
    markers: Array.from({ length: 256 }, (_, i) => ({ id: i + 1, name: `metric-${i}`, kind: 'histogram', buckets: Array.from({ length: 32 }, (_, j) => j) })),
    clock: { id: 'clock', epoch: '1', unit: 'ms', now: () => 0 }, scheduler: { set: () => 0, clear() {} } });
  const plan = p.prepare({ mode: 'stats', durationMs: 1000, maxBytes: 256 * 1024 });
  assert.equal(plan.ok, true); assert.equal(p.start({ token: plan.token, requestId: 'r', captureId: 'c' }).ok, true);
  for (let i = 1; i <= 256; i++) host.stats.observe(i, 100);
  assert.equal(p.status().allocatedBytes, 143360);
  assert.ok(p.status().allocatedBytes <= 256 * 1024);
  assert.ok(p.status().stats.every(s => s.count === 1 && s.buckets.length === 33 && s.buckets[32] === 1));
  p.stop(); p.release(); assert.equal(p.status().allocatedBytes, 0);
});
