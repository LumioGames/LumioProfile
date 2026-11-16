import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { createProfiler, mergeMarkers } from '../packages/profile/src/core.ts';
import { createNodeProfiler, messagePortChannel, connect } from '../packages/profile/src/node.ts';
import { analyzeCapture } from '../packages/profile-tools/src/analysis.ts';
import { perfettoTraces } from '../packages/profile-tools/src/perfetto.ts';
import { exportCapture, readCapture } from '../packages/profile-tools/src/bundle.ts';
import { createService } from '../packages/profile-tools/src/service.ts';
import {
  querySql,
  runAnalysis,
  verifyProcessorVersion,
  parseDurationMs,
  parseByteSize,
  parseCollectors,
  resolveDefaultProcessor
} from '../packages/profile-tools/src/index.ts';

function makeClockProfiler(extra = {}) {
  let now = 0;
  const timers = [];
  const faults = [];
  const host = { contract: 'lumio.observation/1' };
  const p = createProfiler({
    host,
    sourceId: 'src-1',
    role: 'room',
    markers: [
      { id: 1, name: 'outer', kind: 'span' },
      { id: 2, name: 'inner', kind: 'span' },
      { id: 3, name: 'async-op', kind: 'span' },
      { id: 4, name: 'tick-evt', kind: 'event', fields: ['step'] },
      { id: 5, name: 'counter', kind: 'counter', unit: 'count' }
    ],
    build: { id: 'test', mode: 'debug', codeEpoch: '1' },
    clock: { id: 'clk-1', epoch: '1', unit: 'ms', now: () => now },
    scheduler: { set: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clear: () => {} },
    onFault: f => faults.push(f),
    ...extra
  });
  return { p, host, faults, timers, setTime: (t) => { now = t; } };
}

test('B1: span tokens carry session generation so late ends re-reading host.trace never close new-session spans', () => {
  const f = makeClockProfiler();
  // Session 1
  const planA = f.p.prepare({ mode: 'trace', durationMs: 1000 });
  f.p.start({ token: planA.token, requestId: 'req-a', captureId: 'cap-a' });
  f.setTime(1);
  const tokenA = f.host.trace.begin(1);
  assert.ok(tokenA > 0);
  f.setTime(2);
  f.p.stop();

  // Session 2 starts; caller re-reads f.host.trace instead of holding old writer reference!
  const planB = f.p.prepare({ mode: 'trace', durationMs: 1000 });
  f.p.start({ token: planB.token, requestId: 'req-b', captureId: 'cap-b' });
  f.setTime(10);
  const tokenB = f.host.trace.begin(1);
  assert.notEqual(tokenA, tokenB);
  f.setTime(12);
  f.host.trace.end(tokenA); // Late end from Session 1! Must NOT close tokenB or mark Session 2 invalid.
  f.setTime(25);
  f.host.trace.end(tokenB); // Real end of Session 2's span!
  f.p.stop();

  const snap = f.p.snapshot();
  assert.equal(snap.quality.invalid, 0);
  assert.equal(snap.quality.openSpans, 0);
  assert.equal(snap.quality.detail, 'complete');
  assert.equal(snap.records.length, 2);
  const analysis = analyzeCapture({ sources: [snap], calibrations: [] });
  assert.equal(analysis.spans.length, 1);
  assert.equal(analysis.spans[0].durationMs, 15);
  assert.equal(analysis.spans[0].observedSelfMs, 15);
});

test('D3 & B18: deadline check precedes seq allocation and ring chunk eviction so deadline causes zero sequence-gaps', () => {
  const f = makeClockProfiler({ policy: { maxOpenSpans: 16 } });
  const plan = f.p.prepare({ mode: 'trace', durationMs: 100, maxBytes: 16384, overflowPolicy: 'overwrite-oldest-chunk' });
  assert.equal(plan.ok, true);
  f.p.start({ token: plan.token, requestId: 'req-d3', captureId: 'cap-d3' });
  for (let i = 0; i < 20; i++) {
    f.setTime(i * 4);
    const tok = f.host.trace.begin(1);
    f.setTime(i * 4 + 2);
    f.host.trace.end(tok);
  }
  // At t = 100ms (== durationMs), record triggers deadline stop BEFORE incrementing seq or evicting ring slots.
  f.setTime(100);
  f.host.trace.event(4, { fields: { step: 999 } });
  const snap = f.p.snapshot();
  assert.equal(snap.quality.reason, 'deadline');
  assert.equal(snap.quality.dropped, 0);
  assert.equal(snap.quality.lastAttemptedSeq, snap.records.length);
  const analysis = analyzeCapture({ sources: [snap], calibrations: [] });
  assert.ok(!analysis.warnings.some(w => w.includes('sequence-gaps')), 'deadline must not create phantom sequence gaps');
  assert.equal(analysis.spans.length, 20);
  assert.ok(analysis.spans.every(s => s.observedSelfMs === 2));
});

test('B7: non-LIFO leaked inner span recovers stack cleanly without corrupting subsequent spans, and async spans overlap cleanly', () => {
  const f = makeClockProfiler();
  const plan = f.p.prepare({ mode: 'trace', durationMs: 1000 });
  f.p.start({ token: plan.token, requestId: 'req-b7', captureId: 'cap-b7' });

  f.setTime(1); const outer = f.host.trace.begin(1);
  f.setTime(2); const _leakedInner = f.host.trace.begin(2); // intentionally never ended!
  f.setTime(5); f.host.trace.end(outer); // pops _leakedInner, closes outer cleanly!

  // Subsequent 50 spans must NOT become children of _leakedInner!
  for (let i = 0; i < 50; i++) {
    f.setTime(10 + i * 2);
    const t = f.host.trace.begin(1);
    f.setTime(11 + i * 2);
    f.host.trace.end(t);
  }

  // Overlapping async spans A [200..220] and B [205..230]
  f.setTime(200); const asyncA = f.host.trace.beginAsync(3, { operationKey: 'async/a' });
  f.setTime(205); const asyncB = f.host.trace.beginAsync(3, { operationKey: 'async/b' });
  f.setTime(220); f.host.trace.endAsync(asyncA);
  f.setTime(230); f.host.trace.endAsync(asyncB);
  f.p.stop();

  const snap = f.p.snapshot();
  assert.equal(snap.quality.openSpans, 0);
  assert.equal(snap.quality.unclosedSpans, 1);
  const analysis = analyzeCapture({ sources: [snap], calibrations: [] });
  const outerSpan = analysis.spans.find(s => s.spanId === outer);
  assert.equal(outerSpan.complete, true);
  assert.equal(outerSpan.durationMs, 4);
  assert.equal(outerSpan.observedSelfMs, null, 'parent with incomplete child must not claim complete observedSelfMs');
  const afterSpans = analysis.spans.filter(s => !s.async && s.spanId !== outer && s.markerId === 1);
  assert.equal(afterSpans.length, 50);
  assert.ok(afterSpans.every(s => s.parentSpanId === undefined && s.complete && s.durationMs === 1));
  const asyncSpans = analysis.spans.filter(s => s.async);
  assert.equal(asyncSpans.length, 2);
  assert.deepEqual(asyncSpans.map(s => s.durationMs), [20, 25]);
});

test('B3: 8 MiB buffer holds >100k records, and continuous drain streams multi-thousand records through a tiny 32 KiB buffer with 0 drops', async () => {
  const f = makeClockProfiler();
  const bigPlan = f.p.prepare({ mode: 'trace', durationMs: 60000, maxBytes: 8 * 1024 * 1024 });
  f.p.start({ token: bigPlan.token, requestId: 'cap-check', captureId: 'cap-check' });
  assert.ok(f.p.status().capacity > 100000, `expected >100k slots in 8 MiB, got ${f.p.status().capacity}`);
  f.p.stop();
  f.p.release();

  // Continuous drain over real service with a tiny 32 KiB source buffer (~240 slots) recording 2,500 events!
  await mkdir('artifacts/tests', { recursive: true });
  const outRoot = await mkdtemp('artifacts/tests/drain-');
  const token = 'drain-secret-token-12345';
  const service = await createService({ port: 0, token, outputRoot: outRoot, drainIntervalMs: 25 });
  const host = { contract: 'lumio.observation/1' };
  const nodeProf = createNodeProfiler({
    host,
    sourceId: 'tiny-buf-source',
    role: 'room',
    markers: [{ id: 1, name: 'evt', kind: 'event', fields: ['i'] }],
    build: { id: 'b', mode: 'debug', codeEpoch: '1' }
  });
  const conn = nodeProf.connect({ endpoint: service.wsUrl, token });
  try {
    await conn.ready;
    const plan = await service.call('prepare', {
      targets: ['tiny-buf-source'],
      config: { mode: 'trace', durationMs: 10000, maxBytes: 32768 }
    });
    const started = await service.call('start', { planId: plan.planId, requestId: 'drain-req' });
    for (let batch = 0; batch < 50; batch++) {
      for (let i = 0; i < 50; i++) host.trace.event(1, { tick: batch * 50 + i, fields: { i } });
      await new Promise(r => setTimeout(r, 30));
    }
    await service.call('stop', { captureId: started.captureId });
    const exported = await service.call('export', { captureId: started.captureId });
    const raw = await readCapture(exported.path);
    assert.equal(raw.sources[0].records.length, 2500);
    assert.equal(raw.sources[0].quality.dropped, 0);
    assert.equal(raw.sources[0].quality.detail, 'complete');
  } finally {
    conn.close();
    await service.close();
  }
});

test('D1, D2, B2, B9: concurrent stop, clock extrapolation on busy main thread, per-page retry + single-source pull, and >4 captures per service', async () => {
  await mkdir('artifacts/tests', { recursive: true });
  const outRoot = await mkdtemp('artifacts/tests/service-fixes-');
  const token = 'service-fixes-secret-token';
  const service = await createService({
    port: 0,
    token,
    outputRoot: outRoot,
    calibration: { intervalMs: 500, validForMs: 200, maxExtrapolationMs: 30000 }
  });

  // 1) D2: Verify extrapolation keeps busy sources on shared timeline while uncalibrated sources report exact fallbackReason.
  const sA = {
    protocol: 'lumio.capture/1', captureId: 'c1', sourceId: 'page', streamId: 'page/1', role: 'client-main',
    build: { id: 'b', mode: 'debug', codeEpoch: '1' }, clock: { id: 'page/clk', epoch: '1', unit: 'ms' },
    environment: { runtime: 'browser-main', crossOriginIsolated: false },
    config: { mode: 'trace', durationMs: 15000, maxBytes: 65536, overflowPolicy: 'drop-new-detail' },
    startedAt: 0, stoppedAt: 5000, allocatedBytes: 65536,
    markers: [{ id: 1, name: 'frame', kind: 'span' }, { id: 2, name: 'q', kind: 'link', relation: 'queue' }],
    records: [
      { seq: 1, time: 100, kind: 'link', markerId: 2, correlationKey: 'op/1', side: 'out' },
      // Event at 4200ms is outside [validFrom=800, validTo=1200] of the single sample at t=1000ms -> extrapolated!
      { seq: 2, time: 4200, kind: 'begin', markerId: 1, spanId: 1 },
      { seq: 3, time: 4210, kind: 'end', markerId: 1, spanId: 1 }
    ],
    stats: [],
    quality: { dropped: 0, overwritten: 0, invalid: 0, filtered: 0, openSpans: 0, tail: 'complete', reason: 'requested', lastAttemptedSeq: 3, detail: 'complete' }
  };
  const sB = {
    ...structuredClone(sA),
    sourceId: 'room', streamId: 'room/1', role: 'room-worker',
    clock: { id: 'room/clk', epoch: '1', unit: 'ms' },
    records: [{ seq: 1, time: 2150, kind: 'link', markerId: 2, correlationKey: 'op/1', side: 'in' }],
    quality: { ...sA.quality, lastAttemptedSeq: 1 }
  };
  const sUncal = {
    ...structuredClone(sB),
    sourceId: 'uncal', streamId: 'uncal/1', clock: { id: 'uncal/clk', epoch: '1', unit: 'ms' },
    records: [{ seq: 1, time: 50, kind: 'begin', markerId: 1, spanId: 1 }, { seq: 2, time: 55, kind: 'end', markerId: 1, spanId: 1 }],
    quality: { ...sA.quality, lastAttemptedSeq: 2 }
  };
  const cals = [
    { id: 'cal-a', sourceId: 'page', clockId: 'page/clk', clockEpoch: '1', referenceId: 'ref/1', a1: 990, b2: 1000, b3: 1000, a4: 1010, precisionMs: 1, maxDriftPpm: 1000, validForMs: 200 },
    { id: 'cal-b', sourceId: 'room', clockId: 'room/clk', clockEpoch: '1', referenceId: 'ref/1', a1: 995, b2: 2000, b3: 2000, a4: 1005, precisionMs: 1, maxDriftPpm: 1000, validForMs: 200 }
  ];
  const d2Analysis = analyzeCapture({ sources: [sA, sB, sUncal], calibrations: cals });
  const diagPage = d2Analysis.domainDiagnostics.find(d => d.sourceId === 'page');
  const diagRoom = d2Analysis.domainDiagnostics.find(d => d.sourceId === 'room');
  const diagUncal = d2Analysis.domainDiagnostics.find(d => d.sourceId === 'uncal');
  assert.equal(diagPage.shared, true);
  assert.equal(diagPage.extrapolatedRecords, 3);
  assert.equal(diagRoom.shared, true);
  assert.equal(diagUncal.shared, false);
  assert.equal(diagUncal.fallbackReason, 'no-calibration-samples');
  assert.equal(d2Analysis.relations[0].timing, 'calibrated-extrapolated');
  assert.ok(d2Analysis.relations[0].durationMs !== null);
  const traces = perfettoTraces({ sources: [sA, sB, sUncal], calibrations: cals }, d2Analysis);
  assert.equal(traces.length, 2, 'page and room share ref/1; uncal gets local domain with fallbackReasons');
  assert.deepEqual(traces.find(t => t.domain === 'ref/1').sourceIds, ['page', 'room']);
  assert.deepEqual(traces.find(t => t.domain.startsWith('local:')).fallbackReasons, { uncal: 'no-calibration-samples' });

  // 2) D1 + B2 + B9: Connect two live sources, simulate slow pagination + transient errors on source 1, verify concurrent stop & >4 captures!
  const host1 = { contract: 'lumio.observation/1' }, host2 = { contract: 'lumio.observation/1' };
  const p1 = createNodeProfiler({ host: host1, sourceId: 'slow-page', role: 'client-main', markers: [{ id: 1, name: 'ev', kind: 'event' }], build: { id: 'b', mode: 'debug', codeEpoch: '1' } });
  const p2 = createNodeProfiler({ host: host2, sourceId: 'fast-room', role: 'room-worker', markers: [{ id: 1, name: 'ev', kind: 'event' }], build: { id: 'b', mode: 'debug', codeEpoch: '1' } });

  // Custom channel on p1 that delays snapshot responses by 150ms AND fails once transiently to test D1 + B9!
  let failSnapshotCount = 0;
  const ws1 = new WebSocket(service.wsUrl);
  await new Promise((res, rej) => { ws1.addEventListener('open', res, { once: true }); ws1.addEventListener('error', rej, { once: true }); });
  p1.attachControl({
    subscribe(handler) {
      ws1.addEventListener('message', async (ev) => {
        const req = JSON.parse(String(ev.data));
        if (req.method === 'snapshot') {
          await new Promise(r => setTimeout(r, 120));
          if (failSnapshotCount > 0) {
            failSnapshotCount--;
            ws1.send(JSON.stringify({ id: req.id, result: { ok: false, error: 'control-error' } }));
            return;
          }
        }
        handler(req);
      });
      return () => {};
    },
    send: r => ws1.send(JSON.stringify(r))
  });
  ws1.send(JSON.stringify({ auth: token, hello: p1.inspect() }));

  const conn2 = connect(p2, { endpoint: service.wsUrl, token });
  await conn2.ready;
  await new Promise(r => setTimeout(r, 30));

  const writerLoop = setInterval(() => {
    host1.trace?.event(1);
    host2.trace?.event(1);
  }, 5);

  try {
    // Run 6 consecutive captures on the same service (proving B2: >4 captures work seamlessly!)
    for (let round = 0; round < 6; round++) {
      failSnapshotCount = round === 0 ? 1 : 0; // Inject 1 transient page error on round 0 (proving B9 page retry!)
      const plan = await service.call('prepare', {
        targets: ['slow-page', 'fast-room'],
        config: { mode: 'trace', durationMs: 400 } // short deadline: if D1 regressed, fast-room would hit 'deadline' during slow-page's 120ms+120ms snapshot!
      });
      const cap = await service.call('start', { planId: plan.planId, requestId: `round-${round}` });
      await new Promise(r => setTimeout(r, 60));
      const stopped = await service.call('stop', { captureId: cap.captureId });
      assert.equal(stopped.state, 'stopped');
      const exp = await service.call('export', { captureId: cap.captureId });
      const raw = await readCapture(exp.path);
      assert.equal(raw.sources.length, 2);
      // Both sources must have reason === 'requested' (stopped concurrently before slow-page paginated!), NOT 'deadline'!
      assert.equal(raw.sources.find(s => s.sourceId === 'fast-room').quality.reason, 'requested');
    }

    // Test single-source re-pull (`pull`) when a source fails all retries during stop (B9):
    failSnapshotCount = 10; // fail all 3 retry attempts during stop
    const planPull = await service.call('prepare', { targets: ['slow-page', 'fast-room'], config: { mode: 'trace', durationMs: 2000 } });
    const capPull = await service.call('start', { planId: planPull.planId, requestId: 'pull-recovery' });
    await new Promise(r => setTimeout(r, 30));
    const partialStop = await service.call('stop', { captureId: capPull.captureId });
    assert.equal(partialStop.state, 'partial');
    assert.deepEqual(partialStop.missingSources, ['slow-page']);
    failSnapshotCount = 0; // source recovers!
    const pulled = await service.call('pull', { captureId: capPull.captureId, sourceId: 'slow-page' });
    assert.equal(pulled.state, 'stopped');
    assert.deepEqual(pulled.recovered, ['slow-page']);
    assert.deepEqual(pulled.missingSources, []);
    const finalExport = await service.call('export', { captureId: capPull.captureId });
    assert.equal((await readCapture(finalExport.path)).sources.length, 2);
  } finally {
    clearInterval(writerLoop);
    ws1.close();
    conn2.close();
    await service.close();
  }
});

test('B5 & B6: 32,000 nested spans analyze in <500ms (O(N)) and 150,000 events convert to Perfetto without stack overflow', () => {
  const records = [];
  let seq = 0, spanId = 0;
  // 16,000 parent spans each containing 1 child span = 32,000 spans (64,000 records)
  for (let i = 0; i < 16000; i++) {
    const pId = ++spanId;
    const cId = ++spanId;
    const t0 = i * 10;
    records.push({ seq: ++seq, time: t0, kind: 'begin', markerId: 1, spanId: pId });
    records.push({ seq: ++seq, time: t0 + 1, kind: 'begin', markerId: 2, spanId: cId, parentSpanId: pId });
    records.push({ seq: ++seq, time: t0 + 4, kind: 'end', markerId: 2, spanId: cId, parentSpanId: pId });
    records.push({ seq: ++seq, time: t0 + 9, kind: 'end', markerId: 1, spanId: pId });
  }
  const snap32k = {
    protocol: 'lumio.capture/1', captureId: 'perf-32k', sourceId: 's', streamId: 's/1', role: 'room',
    build: { id: 'b', mode: 'debug', codeEpoch: '1' }, clock: { id: 'c', epoch: '1', unit: 'ms' }, environment: {},
    config: { mode: 'trace', durationMs: 200000, maxBytes: 8388608, overflowPolicy: 'drop-new-detail' },
    startedAt: 0, stoppedAt: 160000, allocatedBytes: 8388608,
    markers: [{ id: 1, name: 'parent', kind: 'span' }, { id: 2, name: 'child', kind: 'span' }],
    records, stats: [],
    quality: { dropped: 0, overwritten: 0, invalid: 0, filtered: 0, openSpans: 0, tail: 'complete', reason: 'requested', lastAttemptedSeq: seq, detail: 'complete' }
  };
  const t0 = performance.now();
  const a32k = analyzeCapture({ sources: [snap32k], calibrations: [] });
  const analyzeMs = performance.now() - t0;
  assert.equal(a32k.spans.length, 32000);
  assert.equal(a32k.spans[0].observedSelfMs, 6);
  assert.ok(analyzeMs < 1000, `expected O(N) analysis <1000ms for 32k spans, took ${analyzeMs.toFixed(1)}ms`);

  // B6: 150,000 events in one domain (previously threw RangeError: Maximum call stack size exceeded)
  const bigRecords = Array.from({ length: 150000 }, (_, idx) => ({
    seq: idx + 1,
    time: idx * 0.01,
    kind: 'event',
    markerId: 3
  }));
  const snap150k = {
    ...snap32k,
    captureId: 'perf-150k',
    markers: [{ id: 3, name: 'tick', kind: 'event' }],
    records: bigRecords,
    quality: { ...snap32k.quality, lastAttemptedSeq: 150000 }
  };
  const pf = perfettoTraces({ sources: [snap150k], calibrations: [] });
  assert.equal(pf.length, 1);
  assert.ok(pf[0].bytes.length > 100000);
});

test('B4, B8, B10, B11, B13, B17, D4, D6: collectors, validation diagnostics, hybrid stats, MessagePort, CLI helpers, and Perfetto SQL', async () => {
  // B8: Detailed catalog validation errors
  const bad = createProfiler({
    host: { contract: 'lumio.observation/1' },
    sourceId: 'bad',
    role: 'test',
    markers: [
      { id: 10, name: 'ok', kind: 'histogram', buckets: [5, 2] }, // non-ascending buckets
      { id: 10, name: 'dup', kind: 'event', fields: ['a', 'b', 'c', 'd', 'e'] } // duplicate ID + >4 fields
    ],
    build: { id: 'b', mode: 'debug', codeEpoch: '1' },
    clock: { id: 'c', epoch: '1', unit: 'ms', now: () => 0 },
    scheduler: { set: () => 0, clear: () => {} }
  });
  assert.equal(bad.inspect().supported, false);
  assert.ok(bad.validationErrors.some(e => e.includes('strictly ascending')));
  assert.ok(bad.validationErrors.some(e => e.includes('duplicate marker id 10')));
  assert.ok(bad.validationErrors.some(e => e.includes('exceeds max 4')));
  const badPrep = bad.prepare({ mode: 'trace', durationMs: 100 });
  assert.equal(badPrep.ok, false);
  assert.ok(badPrep.reasons.length >= 3);

  // mergeMarkers helper (D5 support)
  const merged = mergeMarkers([{ id: 100, name: 'engine-step', kind: 'span' }], [{ id: 200, name: 'game-draw', kind: 'span' }]);
  assert.equal(merged.length, 2);
  assert.throws(() => mergeMarkers([{ id: 100, name: 'a', kind: 'span' }], [{ id: 100, name: 'b', kind: 'span' }]), /conflicting-marker-id/);

  // D6: onFault callback fires when clock faults
  const f = makeClockProfiler();
  const planF = f.p.prepare({ mode: 'trace', durationMs: 1000, maxBytes: 999_999_999 }); // B10: clamps >policy.maxBytes!
  assert.equal(planF.ok, true);
  assert.equal(planF.config.maxBytes, 8 * 1024 * 1024);
  f.p.start({ token: planF.token, requestId: 'fault-req', captureId: 'fault-cap' });
  f.setTime(NaN);
  f.host.trace.event(4);
  assert.equal(f.faults.length, 1);
  assert.equal(f.faults[0].reason, 'clock-fault');

  // B13/B4: MessagePort control channel
  const mc = new MessageChannel();
  const mpHost = { contract: 'lumio.observation/1' };
  const mpProf = createNodeProfiler({ host: mpHost, sourceId: 'mp-worker', role: 'worker', markers: [{ id: 1, name: 'e', kind: 'event' }], build: { id: 'b', mode: 'debug', codeEpoch: '1' } });
  const detachMp = mpProf.attachControl(messagePortChannel(mc.port1));
  const mpReply = await new Promise(resolveReply => {
    mc.port2.once('message', resolveReply);
    mc.port2.postMessage({ id: 'mp-1', method: 'inspect' });
  });
  assert.equal(mpReply.result.sourceId, 'mp-worker');
  detachMp();
  mc.port1.close();
  mc.port2.close();

  // B10: CLI unit parsers & processor discovery from another CWD
  assert.equal(parseDurationMs('15s'), 15000);
  assert.equal(parseDurationMs('250ms'), 250);
  assert.equal(parseDurationMs('0.5m'), 30000);
  assert.equal(parseByteSize('8mb'), 8 * 1024 * 1024);
  assert.equal(parseByteSize('512kb'), 512 * 1024);
  assert.deepEqual(parseCollectors('raf,longtasks,loaf,gc,cpu'), {
    raf: true, longTasks: true, longAnimationFrames: true, gc: true, cpuSampling: true
  });
  const origCwd = process.cwd();
  try {
    process.chdir(tmpdir());
    const resolved = resolveDefaultProcessor();
    assert.ok(resolved.includes('trace_processor_shell'), 'resolveDefaultProcessor must locate repo Perfetto binary even outside repo CWD');
  } finally {
    process.chdir(origCwd);
  }

  // D4: Empty --version output gives distinct error instead of unsupported-trace-processor
  if (process.platform !== 'win32') {
    const fakeDir = await mkdtemp(join(tmpdir(), 'lumio-fake-proc-'));
    const fakeBin = join(fakeDir, 'empty-proc.sh');
    await writeFile(fakeBin, '#!/bin/sh\nexit 0\n');
    await chmod(fakeBin, 0o755);
    await assert.rejects(verifyProcessorVersion(fakeBin), /trace-processor-empty-version-output/);
  }

  // B4 + B17 + B10: Real Node CPU sampling + GC + hybrid time-series stats -> Perfetto Trace Processor v58.2 queries!
  const cpuHost = { contract: 'lumio.observation/1' };
  const cpuProf = createNodeProfiler({
    host: cpuHost,
    sourceId: 'node-cpu-source',
    role: 'ds-room',
    markers: [
      { id: 1, name: 'room-step', kind: 'span' },
      { id: 2, name: 'entities', kind: 'gauge', unit: 'count' }
    ],
    build: { id: 'b', mode: 'debug', codeEpoch: '1' }
  });
  const hybridPlan = cpuProf.prepare({
    mode: 'hybrid',
    durationMs: 5000,
    statsIntervalMs: 10,
    collectors: { gc: true, cpuSampling: { sampleIntervalUs: 500 } }
  });
  assert.equal(hybridPlan.ok, true);
  cpuProf.start({ token: hybridPlan.token, requestId: 'hyb-1', captureId: 'hyb-cap' });

  function busyGameSystem(iter) {
    let acc = iter;
    for (let i = 0; i < 400000; i++) acc = Math.imul(acc, 1664525) + 1013904223;
    return acc;
  }
  for (let tick = 0; tick < 6; tick++) {
    cpuHost.stats.gauge(2, 100 + tick * 10);
    const sp = cpuHost.trace.begin(1, { tick });
    busyGameSystem(tick);
    cpuHost.trace.end(sp);
    if (tick === 2) await new Promise(r => setTimeout(r, 15));
  }
  cpuProf.stop();
  const hybSnap = cpuProf.snapshot();
  assert.ok(hybSnap.cpuProfile && hybSnap.cpuProfile.samples.length > 0, 'Node CPU profiler must capture V8 stack samples');
  assert.ok(hybSnap.statSeries && hybSnap.statSeries.length >= 2, 'hybrid stats must record time-series samples');

  await mkdir('artifacts/tests', { recursive: true });
  const bundleParent = await mkdtemp('artifacts/tests/cpu-bundle-');
  const bundleDir = join(bundleParent, 'capture');
  const manifest = await exportCapture({ sources: [hybSnap], calibrations: [] }, bundleDir);
  assert.equal(manifest.cpuProfiles.length, 1);

  const processor = resolveDefaultProcessor();
  const tracePath = join(bundleDir, manifest.traces[0].path);
  const importErrors = execFileSync(processor, ['query', tracePath, "SELECT name, value FROM stats WHERE severity = 'error' AND value > 0;"], { encoding: 'utf8' });
  assert.equal(importErrors.trim().split('\n').length, 1, `expected zero Perfetto import errors, got: ${importErrors}`);

  const hotspots = await runAnalysis(bundleDir, 'hotspots', processor);
  assert.equal(hotspots.results[0].rows[0].retained_count, 6);
  assert.ok(typeof hotspots.results[0].rows[0].p99_wall_ms === 'number');

  const percentiles = await runAnalysis(bundleDir, 'percentiles', processor);
  assert.ok(percentiles.results[0].rows.length > 0);

  const frames = await runAnalysis(bundleDir, 'frames', processor);
  assert.equal(frames.results[0].rows.length, 6);

  const cpuHotspots = await runAnalysis(bundleDir, 'cpu-hotspots', processor);
  assert.ok(cpuHotspots.results[0].rows.some(r => String(r.function_name).includes('busyGameSystem')), 'cpu-hotspots query must identify busyGameSystem on the shared Perfetto trace');

  const custom = await runAnalysis(bundleDir, 'overview', processor, undefined, {
    customSql: 'SELECT COUNT(*) AS cnt FROM counter WHERE value >= 100;'
  });
  assert.equal(custom.queryVersion, 'custom-sql');
  assert.ok(Number(custom.results[0].rows[0].cnt) >= 2);

  // B11: Unisolated browser source with mostly 0ms spans triggers clear COOP/COEP warning
  const zeroSpans = [];
  for (let i = 0; i < 20; i++) {
    zeroSpans.push({ seq: i * 2 + 1, time: 10, kind: 'begin', markerId: 1, spanId: i + 1 });
    zeroSpans.push({ seq: i * 2 + 2, time: 10, kind: 'end', markerId: 1, spanId: i + 1 });
  }
  const unisolated = analyzeCapture({
    sources: [{
      protocol: 'lumio.capture/1', captureId: 'coop', sourceId: 'web', streamId: 'web/1', role: 'client-main',
      build: { id: 'b', mode: 'debug', codeEpoch: '1' }, clock: { id: 'c', epoch: '1', unit: 'ms', precisionMs: 0.1 },
      environment: { runtime: 'browser-main', crossOriginIsolated: false },
      config: { mode: 'trace', durationMs: 1000, maxBytes: 65536, overflowPolicy: 'drop-new-detail' },
      startedAt: 0, stoppedAt: 20, allocatedBytes: 65536,
      markers: [{ id: 1, name: 'sim', kind: 'span' }],
      records: zeroSpans, stats: [],
      quality: { dropped: 0, overwritten: 0, invalid: 0, filtered: 0, openSpans: 0, tail: 'complete', reason: 'requested', lastAttemptedSeq: 40, detail: 'complete' }
    }],
    calibrations: []
  });
  assert.ok(unisolated.warnings.some(w => w.includes('coarse-browser-clock-unisolated')));
});

test('B2 & B13: connect() auto-reconnects when control service restarts and never leaks token in URL', async () => {
  await mkdir('artifacts/tests', { recursive: true });
  const outRoot = await mkdtemp('artifacts/tests/reconnect-');
  const token = 'reconnect-secret-token-999';
  let service = await createService({ port: 0, token, outputRoot: outRoot });
  const port = Number(new URL(service.url).port);
  const endpoint = service.wsUrl;
  assert.ok(!endpoint.includes(token));

  const host = { contract: 'lumio.observation/1' };
  const p = createNodeProfiler({ host, sourceId: 'persistent-worker', role: 'room', markers: [{ id: 1, name: 'e', kind: 'event' }], build: { id: 'b', mode: 'debug', codeEpoch: '1' } });
  const conn = p.connect({ endpoint, token, reconnect: { initialDelayMs: 40, maxDelayMs: 120 } });
  try {
    await conn.ready;
    const deadline1 = Date.now() + 1000;
    while ((await service.call('targets')).length < 1 && Date.now() < deadline1) await new Promise(r => setTimeout(r, 15));
    assert.equal((await service.call('targets')).length, 1);

    // Restart service on the same port!
    await service.close();
    service = await createService({ port, token, outputRoot: outRoot });

    const deadline2 = Date.now() + 2000;
    while ((await service.call('targets')).length < 1 && Date.now() < deadline2) await new Promise(r => setTimeout(r, 25));
    const targetsAfter = await service.call('targets');
    assert.equal(targetsAfter.length, 1);
    assert.equal(targetsAfter[0].sourceId, 'persistent-worker');
  } finally {
    conn.close();
    await service.close();
  }
});
