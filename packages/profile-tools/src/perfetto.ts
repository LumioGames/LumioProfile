import protobuf from 'protobufjs';
import { analyzeCapture, type CaptureInput, type EvidenceEvent } from './analysis.ts';

// Wire-compatible subset of Perfetto v58.2 (Apache-2.0). Field numbers are
// verified against upstream protos; native Trace Processor is the integration oracle.
const schema = `syntax = "proto2";
message Trace { repeated TracePacket packet = 1; }
message TracePacket { optional uint64 timestamp = 8; optional uint32 timestamp_clock_id = 58; optional uint32 trusted_packet_sequence_id = 10; optional TrackEvent track_event = 11; optional TrackDescriptor track_descriptor = 60; }
message TrackDescriptor { optional uint64 uuid = 1; optional string name = 2; optional uint64 parent_uuid = 5; optional CounterDescriptor counter = 8; }
message CounterDescriptor {}
message TrackEvent { optional uint32 type = 9; optional uint64 track_uuid = 11; optional string name = 23; repeated DebugAnnotation debug_annotations = 4; optional double double_counter_value = 44; repeated fixed64 flow_ids = 47; repeated fixed64 terminating_flow_ids = 48; }
message DebugAnnotation { optional string name = 10; optional bool bool_value = 2; optional uint64 uint_value = 3; optional int64 int_value = 4; optional double double_value = 5; optional string string_value = 6; }`;
const Trace = protobuf.parse(schema).root.lookupType('Trace');
export function decodePerfetto(bytes: Uint8Array) { return Trace.toObject(Trace.decode(bytes), { longs: String }); }

export function perfettoTraces(input: CaptureInput) {
  const analysis = analyzeCapture(input);
  // A source is placed on a shared axis only when every retained event is covered.
  const domains = new Map<string, string>();
  for (const s of analysis.sources) {
    const es = analysis.events.filter(e => e.streamId === s.streamId);
    const shared = es.length && es.every(e => e.mapped && e.mapped.domain === es[0].mapped?.domain);
    domains.set(s.streamId, shared ? es[0].mapped!.domain : `local:${s.streamId}`);
  }
  const results: { domain: string; bytes: Uint8Array; sourceIds: string[] }[] = [];
  for (const domain of new Set(domains.values())) {
    const sources = analysis.sources.filter(s => domains.get(s.streamId) === domain);
    const sourceStreams = new Set(sources.map(s => s.streamId));
    const events = analysis.events.filter(e => sourceStreams.has(e.streamId));
    const time = (e: EvidenceEvent) => domain.startsWith('local:') ? e.time : e.mapped!.time;
    const base = Math.min(...events.map(time), ...sources.map(s => s.startedAt));
    const ns = (t: number) => BigInt(Math.round((t - base) * 1e6 + 1)).toString();
    const packets: any[] = [], timed: { t: number; order: number; event: any }[] = [];
    let nextTrack = 1, nextFlow = 1;
    const tracks = new Map<string, number>();
    const track = (key: string, name: string, parent?: number, counter = false) => {
      if (tracks.has(key)) return tracks.get(key)!;
      const uuid = nextTrack++; tracks.set(key, uuid);
      packets.push({ trackDescriptor: { uuid, name, parentUuid: parent, counter: counter ? {} : undefined } }); return uuid;
    };
    const args = (values: Record<string, unknown>) => Object.entries(values).filter(([, v]) => v !== undefined && v !== null).map(([name, v]) => ({ name,
      ...(typeof v === 'number' ? { doubleValue: v } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) }) }));
    const emit = (t: number, order: number, uuid: number, type: number, name?: string, values: Record<string, unknown> = {}, extras: object = {}) => timed.push({ t, order, event: { type, trackUuid: uuid, name, debugAnnotations: args(values), ...extras } });
    const flows = new Map<string, { out: number[]; into: number[] }>();
    for (const r of analysis.relations) if (r.relation === 'explicit' && r.from && r.to && sourceStreams.has(r.from.streamId) && sourceStreams.has(r.to.streamId) && time(r.to) >= time(r.from)) {
      const id = nextFlow++;
      const a = flows.get(r.from.ref) ?? { out: [], into: [] }, b = flows.get(r.to.ref) ?? { out: [], into: [] };
      a.out.push(id); b.into.push(id); flows.set(r.from.ref, a); flows.set(r.to.ref, b);
    }
    for (const s of sources) {
      const root = track(s.streamId, `${s.role} [${s.sourceId}]`);
      const work = track(s.streamId + '/work', 'Observed synchronous work', root);
      const phases = track(s.streamId + '/events', 'Phases and causal endpoints', root);
      const quality = track(s.streamId + '/quality', 'Capture quality', root);
      const local = analysis.events.filter(e => e.streamId === s.streamId);
      const earliest = local.length ? Math.min(...local.map(time)) : s.startedAt;
      emit(earliest, -1, quality, 3, 'lumio.quality', { ...s.quality, sourceId: s.sourceId, streamId: s.streamId, buildId: s.build.id, clockId: s.clock.id, domain, mode: s.config.mode, overflowPolicy: s.config.overflowPolicy });
      const spanById = new Map(analysis.spans.filter(p => p.streamId === s.streamId).map(p => [p.spanId, p]));
      for (const e of local) {
        const marker = s.markers.find(m => m.id === e.markerId)!;
        const userFields = Object.fromEntries(Object.entries(e.context?.fields ?? {}).map(([key, value]) => [`field.${key}`, value]));
        const values = { ref: e.ref, sourceId: s.sourceId, streamId: s.streamId, operationKey: e.context?.operationKey, entityKey: e.context?.entityKey, tick: e.context?.tick,
          markerId: e.markerId, buildId: s.build.id, codeEpoch: s.build.codeEpoch, sourceFile: marker.source?.file, sourceLine: marker.source?.line,
          rawTimeMs: e.time, clockUncertaintyMs: e.mapped?.uncertainty, mappingId: e.mapped?.mappingId, ...userFields };
        const span = e.spanId ? spanById.get(e.spanId) : undefined;
        if ((e.kind === 'begin' || e.kind === 'end') && span?.complete) {
          emit(time(e), e.seq, work, e.kind === 'begin' ? 1 : 2, e.kind === 'begin' ? e.name : undefined,
            { ...values, lumioKind: 'execution', observedSelfMs: span.observedSelfMs, localDurationMs: span.durationMs, measurementKind: 'wall', complete: true, evidence: span.evidence.join('|') });
        } else {
          const flow = flows.get(e.ref);
          emit(time(e), e.seq, phases, 3, (e.kind === 'begin' || e.kind === 'end' ? 'incomplete: ' : '') + e.name,
            { ...values, lumioKind: 'event', correlationKey: e.correlationKey, side: e.side, incomplete: e.kind === 'begin' || e.kind === 'end' },
            { flowIds: flow?.out, terminatingFlowIds: flow?.into });
        }
      }
      for (const stat of s.stats) {
        const marker = s.markers.find(m => m.id === stat.markerId)!;
        const uuid = track(`${s.streamId}/counter/${stat.markerId}`, marker.name, root, true);
        emit(s.stoppedAt, 0, uuid, 4, undefined, { lumioKind: 'stats', windowStartMs: s.startedAt, windowEndMs: s.stoppedAt, unit: marker.unit, count: stat.count, sum: stat.sum, min: stat.min, max: stat.max, buckets: JSON.stringify(stat.buckets) }, { doubleCounterValue: marker.kind === 'histogram' ? stat.count : stat.value });
      }
    }
    for (const r of analysis.relations) if (r.from && r.to && sourceStreams.has(r.from.streamId) && sourceStreams.has(r.to.streamId) && r.durationMs !== null && time(r.to) >= time(r.from)) {
      const uuid = track(`relation/${r.key}`, `${r.measurementKind}: ${r.key}`);
      emit(time(r.from), r.from.seq, uuid, 1, r.measurementKind, { lumioKind: 'relation', measurementKind: r.measurementKind, correlationKey: r.key, operationKey: r.from.context?.operationKey ?? r.to.context?.operationKey,
        localDurationMs: r.durationMs, uncertaintyMs: r.uncertaintyMs, timing: r.timing, evidence: r.evidence.join('|') });
      emit(time(r.to), r.to.seq, uuid, 2);
    }
    timed.sort((a, b) => a.t - b.t || a.order - b.order);
    // Timestamps are already normalized to this file's synthetic axis. Use the
    // default trace clock, as in Perfetto's custom-data converter examples.
    for (const p of timed) packets.push({ timestamp: ns(p.t), trustedPacketSequenceId: 1, trackEvent: p.event });
    const object = Trace.fromObject({ packet: packets });
    const error = Trace.verify(object); if (error) throw new Error(error);
    results.push({ domain, bytes: Trace.encode(object).finish(), sourceIds: sources.map(s => s.sourceId) });
  }
  return results;
}
