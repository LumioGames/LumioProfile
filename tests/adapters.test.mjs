import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeProfiler } from '../packages/profile/src/node.ts';
import { createBrowserProfiler } from '../packages/profile/src/browser.ts';
import { createPuertsProfiler } from '../packages/profile/src/puerts.ts';
import { performance } from 'node:perf_hooks';

const config = () => ({ host: { contract: 'lumio.observation/1' }, markers: [{ id: 1, name: 'work', kind: 'span' }], role: 'fixture', build: { id: 'fixture', mode: 'debug', codeEpoch: '1' } });
test('Node records the actual millisecond performance clock without rebasing each capture', () => {
  const opts = config(), p = createNodeProfiler(opts);
  for (const id of ['first', 'second']) {
    const before = performance.now();
    const plan = p.prepare({ mode: 'trace', durationMs: 1000 });
    p.start({ token: plan.token, requestId: id, captureId: id });
    const token = opts.host.trace.begin(1); opts.host.trace.end(token); p.stop();
    const after = performance.now(), s = p.snapshot();
    assert.equal(s.clock.basis, 'node.performance.now');
    assert.equal(s.clock.rawUnit, 'ms');
    assert.equal(Number(s.clock.rawOrigin), performance.timeOrigin);
    assert.ok(s.records.every(r => r.time >= before && r.time <= after));
    assert.ok(s.records[1].time >= s.records[0].time);
    p.release();
  }
});
test('three adapters expose the same capture semantics without assuming Node in PuerTS', () => {
  let crossings = 0;
  const bridge = { sourceId: 'puerts-fixture', clockId: 'native-fixture', clockEpoch: '1', nowMs: () => ++crossings,
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
  for (const [factory, extra] of [[createNodeProfiler, {}], [createBrowserProfiler, {}], [createPuertsProfiler, { nativeBridge: bridge }]]) {
    const opts = { ...config(), ...extra }, p = factory(opts);
    assert.ok(p, 'adapter must exist');
    assert.equal(opts.host.trace, undefined);
    const plan = p.prepare({ mode: 'trace', durationMs: 100 });
    assert.equal(plan.ok, true);
    assert.equal(p.start({ token: plan.token, requestId: 'r', captureId: 'c' }).ok, true);
    const t = opts.host.trace.begin(1); opts.host.trace.end(t); p.stop();
    assert.equal(p.snapshot().records.length, 2);
  }
  const before = crossings;
  const opts = { ...config(), nativeBridge: bridge }; createPuertsProfiler(opts);
  for (let i = 0; i < 1000; i++) if (opts.host.trace) opts.host.trace.event(1);
  assert.equal(crossings, before);
});
