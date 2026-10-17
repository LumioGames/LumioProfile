import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfiler } from '../packages/profile/src/core.ts';

export const markers = [
  { id: 1, name: 'processor', kind: 'span', category: 'execution' },
  { id: 2, name: 'queue-enter', kind: 'link', category: 'queue' },
  { id: 3, name: 'queue-leave', kind: 'link', category: 'queue' },
  { id: 4, name: 'frame', kind: 'event', fields: ['tick'] },
  { id: 5, name: 'ticks', kind: 'counter', unit: 'count' },
  { id: 6, name: 'tick-time', kind: 'histogram', unit: 'ms', buckets: [1, 5, 10, 50] }
];

function fixture(extra = {}) {
  let time = 0, clocks = 0;
  const timers = new Map();
  const host = { contract: 'lumio.observation/1' };
  const p = createProfiler({ host, markers, role: 'test', sourceId: 'source-test',
    build: { id: 'test-build', mode: 'debug', codeEpoch: 'code-1' },
    clock: { id: 'test-clock', epoch: 'epoch-1', unit: 'ms', now: () => { clocks++; return time; } },
    scheduler: { set: (fn) => { timers.set(fn, fn); return fn; }, clear: (id) => timers.delete(id) },
    policy: { maxBytes: 128 * 1024, maxDurationMs: 1000, maxOpenSpans: 16 }, ...extra });
  assert.ok(p, 'profiler factory must return an Off instance');
  return { p, host, timers, setTime: (t) => time = t, clocks: () => clocks };
}
function start(f, config = {}) {
  const prepared = f.p.prepare({ mode: 'trace', durationMs: 100, maxBytes: 32768, ...config });
  assert.equal(prepared.ok, true);
  const result = f.p.start({ token: prepared.token, requestId: 'request-1', captureId: 'capture-1' });
  assert.equal(result.ok, true);
  return result;
}

test('Off has no clock, timer, buffer, writer or argument work in either build', () => {
  for (const mode of ['debug', 'release']) {
    const f = fixture({ build: { id: 'b', mode, codeEpoch: '1' } });
    let contexts = 0;
    for (let i = 0; i < 1000; i++) if (f.host.trace) f.host.trace.event(4, { tick: contexts++ });
    assert.equal(f.clocks(), 0);
    assert.equal(contexts, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.p.status().allocatedBytes, 0);
    assert.equal(f.host.trace, undefined);
    assert.equal(f.host.stats, undefined);
  }
});
test('Release requires explicit host policy; prepare never starts capture', () => {
  const f = fixture({ build: { id: 'b', mode: 'release', codeEpoch: '1' } });
  assert.equal(f.p.prepare({ mode: 'trace', durationMs: 10 }).ok, false);
  assert.equal(f.clocks(), 0);
  const d = fixture();
  assert.equal(d.p.prepare({ mode: 'trace', durationMs: 10 }).ok, true);
  assert.equal(d.clocks(), 0);
  assert.equal(d.host.trace, undefined);
});
test('spans preserve local duration, nesting and operation evidence', () => {
  const f = fixture(); start(f);
  const w = f.host.trace;
  f.setTime(2); const parent = w.begin(1, { operationKey: 'session/player/42' });
  f.setTime(3); const child = w.begin(1);
  f.setTime(5); w.end(child);
  f.setTime(11); w.end(parent);
  f.p.stop();
  const snapshot = f.p.snapshot();
  assert.equal(snapshot.records.length, 4);
  assert.equal(snapshot.records[1].parentSpanId, parent);
  assert.equal(snapshot.records[3].time - snapshot.records[0].time, 9);
  assert.equal(snapshot.quality.tail, 'complete');
  assert.equal(snapshot.quality.openSpans, 0);
});
test('default overflow preserves earliest records and reports exact dropped count', () => {
  const f = fixture(); start(f, { maxBytes: 16384 });
  for (let i = 0; i < 1000; i++) f.host.trace.event(4, { tick: i });
  f.p.stop(); const s = f.p.snapshot();
  assert.equal(s.records[0].seq, 1);
  assert.equal(s.records[0].context.tick, 0);
  assert.equal(s.quality.dropped + s.records.length, 1000);
  assert.ok(s.quality.dropped > 0);
  assert.ok(s.allocatedBytes <= 16384);
});
test('explicit ring drops oldest whole chunks and keeps bounded recent evidence', () => {
  const f = fixture(); start(f, { maxBytes: 16384, overflowPolicy: 'overwrite-oldest-chunk' });
  for (let i = 0; i < 1000; i++) f.host.trace.event(4, { tick: i });
  f.p.stop(); const s = f.p.snapshot();
  assert.ok(s.records[0].seq > 1);
  assert.equal(s.records.at(-1).seq, 1000);
  assert.equal(s.quality.overwritten + s.records.length, 1000);
  assert.equal(s.quality.dropped, 0);
});
test('Stats is independently enabled and bounded without per-update timestamps', () => {
  const f = fixture(); start(f, { mode: 'stats' });
  const reads = f.clocks();
  assert.equal(f.host.trace, undefined);
  for (let i = 0; i < 100; i++) { f.host.stats.add(5, 1); f.host.stats.observe(6, 9); }
  assert.equal(f.clocks(), reads);
  assert.equal(f.p.status().stats.find(x => x.markerId === 5).value, 100);
  f.p.stop(); const s = f.p.snapshot();
  assert.equal(s.stats.find(x => x.markerId === 5).value, 100);
  assert.equal(s.stats.find(x => x.markerId === 6).count, 100);
  assert.equal(s.records.length, 0);
});
test('stop removes slots, late ends cannot enter a new session and retries are idempotent', () => {
  const f = fixture(); const first = start(f);
  const old = f.host.trace; const token = old.begin(1);
  assert.equal(f.p.start({ token: 'unused', requestId: 'request-1', captureId: 'capture-1' }).streamId, first.streamId);
  f.p.stop();
  assert.equal(f.host.trace, undefined);
  const plan = f.p.prepare({ mode: 'trace', durationMs: 50 });
  const second = f.p.start({ token: plan.token, requestId: 'request-2', captureId: 'capture-2' });
  old.end(token);
  f.host.trace.event(4);
  f.p.stop();
  assert.notEqual(second.streamId, first.streamId);
  assert.equal(f.p.snapshot().records.length, 1);
});
test('clock faults and malformed fields never replace gameplay errors', () => {
  const f = fixture(); start(f);
  const original = new Error('gameplay');
  assert.throws(() => { const w = f.host.trace; const id = w.begin(1); try { throw original; } finally { f.setTime(NaN); w.end(id); } }, e => e === original);
  assert.equal(f.host.trace, undefined);
  assert.equal(f.p.status().reason, 'clock-fault');
});
test('deadline stops capture without requiring a host observation', () => {
  const f = fixture(); start(f);
  [...f.timers.values()][0]();
  assert.equal(f.host.trace, undefined);
  assert.equal(f.p.status().reason, 'deadline');
});
