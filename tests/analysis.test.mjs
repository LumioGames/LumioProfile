import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrate, analyzeCapture } from '../packages/profile-tools/src/analysis.ts';

const source = (id, records, quality = {}) => ({ protocol: 'lumio.capture/1', captureId: 'capture', sourceId: id, streamId: id + '/1', role: id,
  build: { id: 'fixture', mode: 'debug', codeEpoch: '1' }, clock: { id: id + '/clock', epoch: '1', unit: 'ms' }, environment: { synthetic: true },
  config: { mode: 'trace', durationMs: 2000, maxBytes: 32768, overflowPolicy: 'drop-new-detail' }, startedAt: 0, stoppedAt: 1100, allocatedBytes: 32768,
  markers: [{ id: 1, name: 'processor', kind: 'span' }, { id: 2, name: 'queue', kind: 'link', relation: 'queue' }], records, stats: [],
  quality: { dropped: 0, overwritten: 0, invalid: 0, filtered: 0, openSpans: 0, tail: 'complete', reason: 'requested', lastAttemptedSeq: records.length, detail: 'complete', ...quality } });
const event = (seq, time, kind, more = {}) => ({ seq, time, kind, markerId: 1, ...more });

test('queue waiting of 1043ms remains separate from 9ms execution', () => {
  const s = source('room', [event(1, 0, 'link', { markerId: 2, correlationKey: 'queue/session/42', side: 'out' }),
    event(2, 1043, 'link', { markerId: 2, correlationKey: 'queue/session/42', side: 'in' }),
    event(3, 1043, 'begin', { spanId: 1, context: { operationKey: 'session/42' } }), event(4, 1052, 'end', { spanId: 1 })]);
  const a = analyzeCapture({ sources: [s], calibrations: [] });
  assert.ok(a, 'analysis must exist');
  assert.equal(a.spans[0].durationMs, 9);
  assert.equal(a.relations[0].durationMs, 1043);
  assert.equal(a.relations[0].measurementKind, 'queue-wait-wall');
});
test('four-point calibration preserves asymmetric uncertainty and validity range', () => {
  const mapping = calibrate({ id: 'cal-1', sourceId: 'b', clockId: 'b/clock', clockEpoch: '1', referenceId: 'a',
    a1: 100, b2: 119, b3: 120, a4: 125, precisionMs: 0.1, maxDriftPpm: 100, validForMs: 1000 });
  assert.ok(mapping, 'clock calibration must exist');
  assert.equal(mapping.offsetMinMs, -5.2);
  assert.equal(mapping.offsetMaxMs, 19.2);
  assert.ok(mapping.uncertaintyMs > 12);
  assert.equal(mapping.method, 'four-point-bounded-drift/1');
});
test('identity without calibration gives a relation but no cross-domain duration', () => {
  const a = analyzeCapture({ sources: [source('a', [event(1, 100, 'link', { markerId: 2, correlationKey: 'session/m1', side: 'out' })]),
    source('b', [event(1, 1, 'link', { markerId: 2, correlationKey: 'session/m1', side: 'in' })])], calibrations: [] });
  assert.ok(a);
  assert.equal(a.relations[0].durationMs, null);
  assert.equal(a.relations[0].timing, 'unaligned');
});
test('missing children invalidate observed self, missing ends never invent duration', () => {
  const s = source('s', [event(1, 0, 'begin', { spanId: 1 }), event(2, 1, 'begin', { spanId: 2, parentSpanId: 1 }), event(4, 9, 'end', { spanId: 1 })], { dropped: 1, detail: 'partial' });
  const a = analyzeCapture({ sources: [s], calibrations: [] }); assert.ok(a);
  assert.equal(a.spans.find(s => s.spanId === 1).durationMs, 9);
  assert.equal(a.spans.find(s => s.spanId === 1).observedSelfMs, null);
  assert.equal(a.spans.find(s => s.spanId === 2).durationMs, null);
  assert.equal(a.populationStatistics, false);
});
test('identical diagnostic retransmits deduplicate; conflicting identities fail closed', () => {
  const s = source('a', [event(1, 1, 'event')]);
  const a = analyzeCapture({ sources: [s, structuredClone(s)], calibrations: [] }); assert.ok(a);
  assert.equal(a.sources.length, 1);
  const conflicting = structuredClone(s); conflicting.records[0].time = 2;
  assert.throws(() => analyzeCapture({ sources: [s, conflicting], calibrations: [] }), /conflicting-stream/);
});
test('duplicate causal endpoints remain ambiguous instead of being collapsed', () => {
  const s = source('a', [event(1, 1, 'link', { markerId: 2, correlationKey: 'same', side: 'out' }), event(2, 2, 'link', { markerId: 2, correlationKey: 'same', side: 'out' }), event(3, 3, 'link', { markerId: 2, correlationKey: 'same', side: 'in' })]);
  const a = analyzeCapture({ sources: [s], calibrations: [] }); assert.ok(a);
  assert.equal(a.relations[0].relation, 'ambiguous');
  assert.equal(a.relations[0].durationMs, null);
});
test('unreported sequence gaps still invalidate complete observed self', () => {
  const s = source('a', [event(1, 0, 'begin', { spanId: 1 }), event(3, 10, 'end', { spanId: 1 })]);
  s.quality.lastAttemptedSeq = 3;
  const a = analyzeCapture({ sources: [s], calibrations: [] });
  assert.equal(a.spans[0].observedSelfMs, null);
  assert.equal(a.populationStatistics, false);
});
test('open spans do not qualify for complete population statistics', () => {
  const s = source('s', [event(1, 0, 'begin', { spanId: 1 })], { openSpans: 1 });
  const a = analyzeCapture({ sources: [s], calibrations: [] });
  assert.equal(a.populationStatistics, false);
});
