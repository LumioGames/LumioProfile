import type { Snapshot, RecordData } from '../../profile/src/types.ts';
export interface CalibrationSample {
  id: string; sourceId: string; clockId: string; clockEpoch: string; referenceId: string;
  a1: number; b2: number; b3: number; a4: number; precisionMs: number; maxDriftPpm: number; validForMs: number;
}
/** Coordinator provenance only. These timestamps never calibrate a source clock. */
export interface SourceLifecycle {
  referenceId: string; captureStartedAt: number; observationStoppedAt?: number;
  selectedSources: { sourceId: string; connectionId: string; registeredAt: number }[];
  events: { kind: 'registered' | 'disconnected'; sourceId: string; connectionId: string; atMs: number; selected: boolean }[];
  droppedEvents: number;
}
export interface CaptureInput { sources: Snapshot[]; calibrations: CalibrationSample[]; missingSources?: string[]; sourceLifecycle?: SourceLifecycle }
export function calibrate(s: CalibrationSample) {
  if (![s.a1, s.b2, s.b3, s.a4, s.precisionMs, s.maxDriftPpm, s.validForMs].every(Number.isFinite) || s.a4 < s.a1 || s.b3 < s.b2 || s.precisionMs < 0 || s.maxDriftPpm < 0 || s.validForMs <= 0) throw new Error('invalid-calibration');
  const offsetMinMs = s.b3 - s.a4 - 2 * s.precisionMs;
  const offsetMaxMs = s.b2 - s.a1 + 2 * s.precisionMs;
  if (offsetMaxMs < offsetMinMs) throw new Error('inconsistent-calibration');
  return { ...s, method: 'four-point-bounded-drift/1', offsetMinMs, offsetMaxMs,
    offsetMs: (offsetMinMs + offsetMaxMs) / 2,
    uncertaintyMs: (offsetMaxMs - offsetMinMs) / 2 + s.validForMs * s.maxDriftPpm / 1e6,
    validFrom: s.b2 - s.validForMs, validTo: s.b3 + s.validForMs,
    assumption: 'nonnegative-transfer; clock-continuity; host-specified-drift-bound' };
}
export type Mapping = ReturnType<typeof calibrate>;
export interface EvidenceEvent extends RecordData { ref: string; streamId: string; sourceId: string; name: string; relationKind?: string; mapped?: { time: number; uncertainty: number; domain: string; mappingId: string } }
export interface SpanResult {
  sourceId: string; streamId: string; spanId: number; parentSpanId?: number; markerId: number; name: string;
  operationKey?: string; begin?: EvidenceEvent; end?: EvidenceEvent; durationMs: number | null; observedSelfMs: number | null;
  measurementKind: 'wall'; complete: boolean; evidence: string[];
}
export interface RelationResult {
  key: string; relation: 'explicit' | 'ambiguous' | 'missing-endpoint'; timing: string;
  durationMs: number | null; uncertaintyMs: number | null; measurementKind: string; evidence: string[];
  from?: EvidenceEvent; to?: EvidenceEvent;
}
function validate(s: Snapshot) {
  if (s.protocol !== 'lumio.capture/1' || !s.streamId || !s.sourceId || !s.clock?.id || s.clock.unit !== 'ms' || !s.quality || !Array.isArray(s.markers) || !Array.isArray(s.records) || s.records.length > 1_000_000 || s.markers.length > 256) throw new Error('invalid-source');
  let previousSeq = 0, previousTime = -Infinity;
  const ids = new Set(s.markers.map(m => m.id));
  for (const e of s.records) {
    if (!Number.isSafeInteger(e.seq) || e.seq <= previousSeq || !Number.isFinite(e.time) || e.time < previousTime || !ids.has(e.markerId) || !['begin', 'end', 'event', 'link'].includes(e.kind)) throw new Error('invalid-record-order-or-marker');
    previousSeq = e.seq; previousTime = e.time;
  }
}
export function analyzeCapture(input: CaptureInput) {
  if (!Array.isArray(input.sources) || input.sources.length > 64 || !Array.isArray(input.calibrations) || input.calibrations.length > 4096) throw new Error('invalid-capture');
  const unique = new Map<string, Snapshot>();
  let captureId: string | undefined;
  for (const s of input.sources) {
    validate(s);
    if (captureId && captureId !== s.captureId) throw new Error('mixed-capture-ids');
    captureId = s.captureId;
    const prior = unique.get(s.streamId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(s)) throw new Error('conflicting-stream');
    unique.set(s.streamId, s);
  }
  const sources = [...unique.values()];
  const mappings = input.calibrations.map(calibrate);
  const events: EvidenceEvent[] = [];
  const spans: SpanResult[] = [];
  const warnings: string[] = [];
  const incompleteStreams = new Set<string>();
  for (const s of sources) {
    if (s.quality.detail !== 'complete' || s.quality.tail !== 'complete' || s.quality.openSpans > 0) warnings.push(`${s.streamId}: incomplete-observation`);
    let previous = 0;
    for (const e of s.records) { if (e.seq !== previous + 1) incompleteStreams.add(s.streamId); previous = e.seq; }
    if (previous !== s.quality.lastAttemptedSeq) incompleteStreams.add(s.streamId);
    if (incompleteStreams.has(s.streamId)) warnings.push(`${s.streamId}: sequence-gaps`);
    const catalog = new Map(s.markers.map(m => [m.id, m]));
    const bySpan = new Map<number, SpanResult>();
    for (const r of s.records) {
      const m = catalog.get(r.markerId)!;
      const e: EvidenceEvent = { ...r, ref: `${s.streamId}:${r.seq}`, streamId: s.streamId, sourceId: s.sourceId, name: m.name, relationKind: m.relation };
      const candidates = mappings.filter(c => c.sourceId === s.sourceId && c.clockId === s.clock.id && c.clockEpoch === s.clock.epoch && r.time >= c.validFrom && r.time <= c.validTo);
      if (candidates.length) {
        const reference = candidates[0].referenceId;
        const lower = Math.max(...candidates.map(c => r.time - c.offsetMs - c.uncertaintyMs));
        const upper = Math.min(...candidates.map(c => r.time - c.offsetMs + c.uncertaintyMs));
        if (upper >= lower && candidates.every(c => c.referenceId === reference)) e.mapped = { time: (lower + upper) / 2, uncertainty: (upper - lower) / 2, domain: reference, mappingId: candidates.map(c => c.id).join(',') };
        else warnings.push(`${e.ref}: conflicting-clock-mappings`);
      }
      events.push(e);
      if ((r.kind === 'begin' || r.kind === 'end') && r.spanId) {
        let span = bySpan.get(r.spanId);
        if (!span) { span = { sourceId: s.sourceId, streamId: s.streamId, spanId: r.spanId, parentSpanId: r.parentSpanId, markerId: r.markerId, name: m.name, durationMs: null, observedSelfMs: null, measurementKind: 'wall', complete: false, evidence: [] }; bySpan.set(r.spanId, span); }
        if (span[r.kind]) throw new Error('duplicate-span-endpoint');
        span[r.kind] = e; span.evidence.push(e.ref);
        if (r.kind === 'begin') span.operationKey = r.context?.operationKey;
      }
    }
    for (const span of bySpan.values()) {
      if (span.begin && span.end && span.begin.markerId === span.end.markerId && span.end.time >= span.begin.time) {
        span.durationMs = span.end.time - span.begin.time; span.complete = true;
      }
    }
    for (const span of bySpan.values()) {
      if (!span.complete || s.quality.detail !== 'complete' || s.quality.invalid || incompleteStreams.has(s.streamId)) continue;
      const children = [...bySpan.values()].filter(c => c.parentSpanId === span.spanId);
      if (children.some(c => !c.complete || c.begin!.time < span.begin!.time || c.end!.time > span.end!.time)) continue;
      const intervals = children.map(c => [c.begin!.time, c.end!.time]).sort((a, b) => a[0] - b[0]);
      let covered = 0, end = -Infinity;
      for (const [a, b] of intervals) { covered += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
      span.observedSelfMs = span.durationMs! - covered;
    }
    spans.push(...bySpan.values());
  }
  const links = new Map<string, EvidenceEvent[]>();
  for (const e of events) if (e.kind === 'link' && e.correlationKey) {
    const group = links.get(e.correlationKey) ?? []; group.push(e); links.set(e.correlationKey, group);
  }
  const relations: RelationResult[] = [];
  for (const [key, endpoints] of links) {
    const out = endpoints.filter(e => e.side === 'out'), into = endpoints.filter(e => e.side === 'in');
    const relation = out.length > 1 || into.length > 1 ? 'ambiguous' : out.length !== 1 || into.length !== 1 ? 'missing-endpoint' : 'explicit';
    const result: RelationResult = { key, relation, timing: 'unavailable', durationMs: null, uncertaintyMs: null,
      measurementKind: 'causal-wall', evidence: endpoints.map(e => e.ref) };
    if (relation === 'explicit') {
      const from = out[0], to = into[0]; result.from = from; result.to = to;
      if (from.relationKind === 'queue' && to.relationKind === 'queue') result.measurementKind = 'queue-wait-wall';
      if (from.streamId === to.streamId) { result.durationMs = to.time - from.time; result.uncertaintyMs = 0; result.timing = 'same-clock'; }
      else if (from.mapped && to.mapped && from.mapped.domain === to.mapped.domain) {
        result.durationMs = to.mapped.time - from.mapped.time; result.uncertaintyMs = from.mapped.uncertainty + to.mapped.uncertainty; result.timing = 'calibrated-estimate';
      } else result.timing = 'unaligned';
      if (result.durationMs !== null && result.durationMs + result.uncertaintyMs! < 0) { warnings.push(`${key}: causal-clock-conflict`); result.timing = 'clock-conflict'; }
    }
    relations.push(result);
  }
  return { version: 'lumio.analysis/1', captureId, sources, events, spans, relations, mappings, warnings,
    missingSources: input.missingSources ?? [], populationStatistics: sources.length > 0 && incompleteStreams.size === 0 && spans.every(s => s.complete) && sources.every(s => s.quality.detail === 'complete' && s.quality.tail === 'complete' && s.quality.invalid === 0 && s.quality.openSpans === 0) && !(input.missingSources?.length),
    measurementNotes: ['wall intervals include scheduling and unobserved work', 'observedSelfMs is relative to instrumented children, not CPU time', 'clock estimates and uncertainty intervals are conditional on configured, not independently validated, precision and drift assumptions', 'no GPU or physical-present measurement'] };
}
