import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfiler } from '../packages/profile/src/core.ts';
const setup = () => {
  let time = 0, handler;
  const host = { contract: 'lumio.observation/1' };
  const p = createProfiler({ host, sourceId: 'source', role: 'test', build: { id: 'b', mode: 'debug', codeEpoch: '1' },
    markers: [{ id: 1, name: 'span', kind: 'span' }, { id: 2, name: 'event', kind: 'event' }], clock: { id: 'c', epoch: '1', unit: 'ms', now: () => time },
    scheduler: { set: () => 1, clear: () => {} } });
  const responses = [];
  p.attachControl({ subscribe: h => { handler = h; return () => {}; }, send: r => responses.push(r) });
  function request(method, params) { handler({ id: 'q', method, params }); return responses.at(-1).result; }
  function start(id) { const plan = p.prepare({ mode: 'trace', durationMs: 100 }); return p.start({ token: plan.token, requestId: id, captureId: id }); }
  return { host, p, request, start };
};
test('late control stop from an old capture cannot stop the current one', () => {
  const f = setup(); f.start('a'); f.p.stop(); f.start('b');
  assert.equal(f.request('stop', { captureId: 'a' }).ok, false);
  assert.equal(f.p.status().active, true);
  f.p.stop();
});
test('writer rejects incompatible marker kinds without producing false spans', () => {
  const f = setup(); f.start('a');
  assert.equal(f.host.trace.begin(2), 0);
  f.host.trace.event(1);
  f.p.stop(); assert.equal(f.p.snapshot().records.length, 0);
});
test('captured build metadata cannot be rewritten by later host mutation', () => {
  const build = { id: 'original', mode: 'debug', codeEpoch: '1' };
  const host = { contract: 'lumio.observation/1' };
  const p = createProfiler({ host, sourceId: 's', role: 's', build, markers: [], clock: { id: 'c', epoch: '1', unit: 'ms', now: () => 0 }, scheduler: { set: () => 0, clear: () => {} } });
  const plan = p.prepare({ mode: 'trace', durationMs: 100 }); p.start({ token: plan.token, requestId: 'r', captureId: 'c' });
  build.id = 'hot-update'; build.codeEpoch = '2'; p.stop();
  assert.equal(p.snapshot().build.id, 'original');
});
test('returned preparation and status objects cannot mutate accepted capture limits', () => {
  const f = setup(); const plan = f.p.prepare({ mode: 'trace', durationMs: 100, maxBytes: 32768 });
  plan.config.maxBytes = 10000000;
  f.p.start({ token: plan.token, requestId: 'r', captureId: 'c' });
  const status = f.p.status(); status.config.overflowPolicy = 'overwrite-oldest-chunk';
  assert.ok(f.p.status().allocatedBytes <= 32768);
  assert.equal(f.p.status().config.overflowPolicy, 'drop-new-detail'); f.p.stop();
});
test('embedded terminators cannot collapse distinct correlation identities', () => {
  const f = setup(); f.start('a');
  f.host.trace.event(2, { operationKey: 'session\u0000other' });
  f.p.stop(); assert.equal(f.p.snapshot().records.length, 0);
  assert.ok(f.p.snapshot().quality.invalid > 0);
});
test('control export pages bounded record batches after stop', () => {
  const f = setup(); f.start('a');
  for (let i = 0; i < 200; i++) f.host.trace.event(2);
  f.p.stop();
  const first = f.request('snapshot', { captureId: 'a', offset: 0 });
  assert.equal(first.records.length, 64);
  assert.equal(first.window.next, 64);
  const next = f.request('snapshot', { captureId: 'a', offset: 64 });
  assert.equal(next.records[0].seq, 65);
});
test('exported capture storage can be released without reviving old writers', () => {
  const f = setup(); f.start('a'); const old = f.host.trace;
  old.event(2); f.p.stop(); const evidence = f.p.snapshot();
  const result = f.request('release', { captureId: 'a' });
  assert.equal(result.ok, true);
  old.event(2);
  assert.equal(f.p.status().allocatedBytes, 0);
  assert.equal(evidence.records.length, 1);
});
