import protobuf from 'protobufjs';
import type { CpuProfileNode } from '../../profile/src/types.ts';
import {
  analyzeCapture,
  type AnalysisResult,
  type CaptureInput,
  type EvidenceEvent,
  type SpanResult
} from './analysis.ts';

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

const AUTO_MEASUREMENT_KIND: Record<string, string> = {
  raf: 'raf-interval',
  longtask: 'browser-longtask-wall',
  'long-animation-frame': 'browser-loaf-wall',
  gc: 'v8-gc-wall'
};

const AUTO_TRACK_TITLE: Record<string, string> = {
  raf: 'Frame intervals (rAF)',
  longtask: 'Browser Long Tasks & LoAF',
  'long-animation-frame': 'Browser Long Tasks & LoAF',
  gc: 'Runtime GC pauses'
};

export function perfettoTraces(input: CaptureInput, precomputedAnalysis?: AnalysisResult) {
  const analysis = precomputedAnalysis ?? analyzeCapture(input);
  const diagByStream = new Map(analysis.domainDiagnostics.map(d => [d.streamId, d]));
  const domains = new Map<string, string>();
  for (const s of analysis.sources) {
    const diag = diagByStream.get(s.streamId);
    domains.set(s.streamId, diag ? diag.domain : `local:${s.streamId}`);
  }

  // Pre-group events and spans by streamId in O(N) instead of repeated O(N) filtering.
  const eventsByStream = new Map<string, EvidenceEvent[]>();
  for (let i = 0; i < analysis.events.length; i++) {
    const e = analysis.events[i];
    let list = eventsByStream.get(e.streamId);
    if (!list) { list = []; eventsByStream.set(e.streamId, list); }
    list.push(e);
  }
  const spansByStream = new Map<string, SpanResult[]>();
  for (let i = 0; i < analysis.spans.length; i++) {
    const sp = analysis.spans[i];
    let list = spansByStream.get(sp.streamId);
    if (!list) { list = []; spansByStream.set(sp.streamId, list); }
    list.push(sp);
  }

  const results: { domain: string; fallbackReasons?: Record<string, string>; bytes: Uint8Array; sourceIds: string[] }[] = [];
  for (const domain of new Set(domains.values())) {
    const isLocal = domain.startsWith('local:');
    const sources = analysis.sources.filter(s => domains.get(s.streamId) === domain);
    const sourceStreams = new Set(sources.map(s => s.streamId));
    const time = (e: EvidenceEvent) => isLocal ? e.time : e.mapped!.time;

    const packets: any[] = [];
    const timed: { t: number; phase: number; order: number; event: any }[] = [];
    let nextTrack = 1, nextFlow = 1, syntheticOrder = 1_000_000_000;
    const tracks = new Map<string, number>();
    const track = (key: string, name: string, parent?: number, counter = false) => {
      const existing = tracks.get(key);
      if (existing !== undefined) return existing;
      const uuid = nextTrack++;
      tracks.set(key, uuid);
      packets.push({ trackDescriptor: { uuid, name, parentUuid: parent, counter: counter ? {} : undefined } });
      return uuid;
    };
    const args = (values: Record<string, unknown>) => Object.entries(values)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([name, v]) => ({
        name,
        ...(typeof v === 'number' ? { doubleValue: v } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) })
      }));
    const emit = (t: number, order: number, uuid: number, type: number, name?: string, values: Record<string, unknown> = {}, extras: object = {}, phase = type === 2 ? 0 : 1) => {
      const event = { type, trackUuid: uuid, name, debugAnnotations: args(values), ...extras };
      timed.push({ t, phase, order, event });
      return event;
    };

    const flows = new Map<string, { out: number[]; into: number[] }>();
    for (let i = 0; i < analysis.relations.length; i++) {
      const r = analysis.relations[i];
      if (r.relation === 'explicit' && r.from && r.to && sourceStreams.has(r.from.streamId) && sourceStreams.has(r.to.streamId) && time(r.to) >= time(r.from)) {
        const id = nextFlow++;
        const a = flows.get(r.from.ref) ?? { out: [], into: [] };
        const b = flows.get(r.to.ref) ?? { out: [], into: [] };
        a.out.push(id); b.into.push(id);
        flows.set(r.from.ref, a); flows.set(r.to.ref, b);
      }
    }

    const fallbackReasons: Record<string, string> = {};
    for (const s of sources) {
      const diag = diagByStream.get(s.streamId);
      if (diag?.fallbackReason) fallbackReasons[s.sourceId] = diag.fallbackReason;

      const root = track(s.streamId, `${s.role} [${s.sourceId}]`);
      const work = track(s.streamId + '/work', 'Observed synchronous work', root);
      const phases = track(s.streamId + '/events', 'Phases and causal endpoints', root);
      const quality = track(s.streamId + '/quality', 'Capture quality', root);
      const local = eventsByStream.get(s.streamId) ?? [];
      const markerById = new Map(s.markers.map(m => [m.id, m]));

      let earliest = Infinity;
      for (let i = 0; i < local.length; i++) {
        const t = time(local[i]);
        if (t < earliest) earliest = t;
      }
      if (!Number.isFinite(earliest)) earliest = isLocal ? s.startedAt : 0;

      emit(earliest, -1, quality, 3, 'lumio.quality', {
        ...s.quality,
        sourceId: s.sourceId,
        streamId: s.streamId,
        buildId: s.build.id,
        clockId: s.clock.id,
        clockResolutionMs: s.clock.precisionMs ?? s.environment?.clockResolutionMs,
        crossOriginIsolated: s.environment?.crossOriginIsolated,
        domain,
        domainFallbackReason: diag?.fallbackReason,
        extrapolatedRecords: diag?.extrapolatedRecords ?? 0,
        maxClockUncertaintyMs: diag?.maxUncertaintyMs ?? 0,
        mode: s.config.mode,
        overflowPolicy: s.config.overflowPolicy
      });

      const streamSpans = spansByStream.get(s.streamId) ?? [];
      const spanById = new Map<number, SpanResult>();
      const completeAsyncSpans: SpanResult[] = [];
      for (let i = 0; i < streamSpans.length; i++) {
        const sp = streamSpans[i];
        spanById.set(sp.spanId, sp);
        if (sp.async && sp.complete) completeAsyncSpans.push(sp);
      }

      // Assign non-overlapping lanes for complete async spans so overlapping async work never triggers misplaced_end_event.
      const asyncLaneBySpanId = new Map<number, number>();
      if (completeAsyncSpans.length > 0) {
        completeAsyncSpans.sort((a, b) => time(a.begin!) - time(b.begin!) || time(a.end!) - time(b.end!));
        const laneEnds: number[] = [];
        for (const sp of completeAsyncSpans) {
          const bt = time(sp.begin!), et = Math.max(bt, time(sp.end!));
          let lane = -1;
          for (let l = 0; l < laneEnds.length; l++) {
            if (laneEnds[l] <= bt) { lane = l; laneEnds[l] = et; break; }
          }
          if (lane < 0) { lane = laneEnds.length; laneEnds.push(et); }
          const laneUuid = track(`${s.streamId}/async/${lane + 1}`, `Observed async work #${lane + 1}`, root);
          asyncLaneBySpanId.set(sp.spanId, laneUuid);
        }
      }

      for (let i = 0; i < local.length; i++) {
        const e = local[i];
        const marker = markerById.get(e.markerId)!;
        const userFields = e.context?.fields
          ? Object.fromEntries(Object.entries(e.context.fields).map(([key, value]) => [`field.${key}`, value]))
          : undefined;
        const values = {
          ref: e.ref,
          sourceId: s.sourceId,
          streamId: s.streamId,
          operationKey: e.context?.operationKey,
          entityKey: e.context?.entityKey,
          tick: e.context?.tick,
          markerId: e.markerId,
          buildId: s.build.id,
          codeEpoch: s.build.codeEpoch,
          sourceFile: marker.source?.file,
          sourceLine: marker.source?.line,
          rawTimeMs: e.time,
          clockUncertaintyMs: e.mapped?.uncertainty,
          clockExtrapolated: e.mapped?.extrapolated,
          mappingId: e.mapped?.mappingId,
          ...userFields
        };
        const span = e.spanId ? spanById.get(e.spanId) : undefined;
        if ((e.kind === 'begin' || e.kind === 'end') && span?.complete) {
          if (span.async) {
            const asyncTrack = asyncLaneBySpanId.get(span.spanId)!;
            emit(
              time(e), e.seq, asyncTrack, e.kind === 'begin' ? 1 : 2,
              e.kind === 'begin' ? e.name : undefined,
              {
                ...values,
                lumioKind: 'async-execution',
                localDurationMs: span.durationMs,
                measurementKind: 'async-wall',
                complete: true,
                evidence: span.evidence.join('|')
              }
            );
          } else {
            emit(
              time(e), e.seq, work, e.kind === 'begin' ? 1 : 2,
              e.kind === 'begin' ? e.name : undefined,
              {
                ...values,
                lumioKind: 'execution',
                observedSelfMs: span.observedSelfMs,
                localDurationMs: span.durationMs,
                measurementKind: 'wall',
                complete: true,
                evidence: span.evidence.join('|')
              }
            );
          }
        } else {
          const flow = flows.get(e.ref);
          emit(
            time(e), e.seq, phases, 3,
            (e.kind === 'begin' || e.kind === 'end' ? 'incomplete: ' : '') + e.name,
            { ...values, lumioKind: 'event', correlationKey: e.correlationKey, side: e.side, incomplete: e.kind === 'begin' || e.kind === 'end' },
            { flowIds: flow?.out, terminatingFlowIds: flow?.into }
          );
        }
      }

      // Emit automatic runtime collectors (rAF intervals, Long Tasks, LoAF, Node GC).
      const autoList = analysis.autoRecordsByStream.get(s.streamId);
      if (autoList?.length) {
        const byGroup = new Map<string, typeof autoList>();
        for (const ar of autoList) {
          const groupKey = ar.kind === 'long-animation-frame' ? 'longtask' : ar.kind;
          let g = byGroup.get(groupKey);
          if (!g) { g = []; byGroup.set(groupKey, g); }
          g.push(ar);
        }
        for (const [groupKey, items] of byGroup) {
          const sorted = items.slice().sort((a, b) => {
            const sa = isLocal ? a.startTime : a.mappedStart!.time;
            const sb = isLocal ? b.startTime : b.mappedStart!.time;
            return sa - sb || a.durationMs - b.durationMs;
          });
          const laneEnds: number[] = [];
          const baseTitle = AUTO_TRACK_TITLE[groupKey] ?? `Runtime (${groupKey})`;
          for (const ar of sorted) {
            const st = isLocal ? ar.startTime : ar.mappedStart!.time;
            const et = Math.max(st, isLocal ? ar.startTime + ar.durationMs : ar.mappedEnd!.time);
            let lane = -1;
            for (let l = 0; l < laneEnds.length; l++) {
              if (laneEnds[l] <= st) { lane = l; laneEnds[l] = et; break; }
            }
            if (lane < 0) { lane = laneEnds.length; laneEnds.push(et); }
            const trackUuid = track(
              `${s.streamId}/auto/${groupKey}/${lane + 1}`,
              lane === 0 ? baseTitle : `${baseTitle} #${lane + 1}`,
              root
            );
            const extraFields = ar.fields
              ? Object.fromEntries(Object.entries(ar.fields).map(([k, v]) => [`field.${k}`, v]))
              : undefined;
            emit(st, ++syntheticOrder, trackUuid, 1, ar.name, {
              sourceId: s.sourceId,
              streamId: s.streamId,
              buildId: s.build.id,
              lumioKind: `auto-${ar.kind}`,
              localDurationMs: ar.durationMs,
              measurementKind: AUTO_MEASUREMENT_KIND[ar.kind] ?? 'auto-wall',
              sourceFile: typeof ar.fields?.url === 'string' ? ar.fields.url : undefined,
              ...extraFields
            });
            emit(et, ++syntheticOrder, trackUuid, 2);
          }
        }
      }

      // Emit sampled JS/CPU call stacks on a nested flamegraph track aligned to the exact same timeline.
      const cpu = analysis.cpuProfilesByStream.get(s.streamId);
      if (cpu && cpu.samples.length > 0 && cpu.timestampsMs.length === cpu.samples.length) {
        const tsArray = !isLocal && cpu.mappedTimestampsMs ? cpu.mappedTimestampsMs : cpu.timestampsMs;
        const nodeById = new Map<number, CpuProfileNode>();
        for (const n of cpu.nodes) nodeById.set(n.id, n);
        const pathCache = new Map<number, CpuProfileNode[]>();
        const getStackPath = (leafId: number): CpuProfileNode[] => {
          const cached = pathCache.get(leafId);
          if (cached) return cached;
          const chain: CpuProfileNode[] = [];
          let cur = nodeById.get(leafId);
          let guard = 0;
          while (cur && guard++ < 64) {
            if (cur.functionName !== '(root)' && cur.functionName !== '(idle)' && cur.functionName !== '(program)') {
              chain.push(cur);
            }
            cur = cur.parentId !== undefined ? nodeById.get(cur.parentId) : undefined;
          }
          chain.reverse();
          pathCache.set(leafId, chain);
          return chain;
        };

        const cpuTrack = track(`${s.streamId}/cpu-samples`, 'Sampled JS/CPU stacks (statistical)', root);
        const defaultStepMs = Math.max(0.1, cpu.sampleIntervalUs / 1000);
        interface OpenFrame {
          node: CpuProfileNode;
          startT: number;
          localStartMs: number;
          selfMs: number;
          leafHits: number;
          beginEvent: any;
        }
        const openFrames: OpenFrame[] = [];
        let prevT = -Infinity;

        const closeDownTo = (targetDepth: number, closeT: number, closeLocalMs: number) => {
          while (openFrames.length > targetDepth) {
            const frame = openFrames.pop()!;
            const durLocal = Math.max(0, closeLocalMs - frame.localStartMs);
            frame.beginEvent.debugAnnotations.push(
              { name: 'localDurationMs', doubleValue: durLocal },
              { name: 'observedSelfMs', doubleValue: frame.selfMs },
              { name: 'sampleHits', doubleValue: frame.leafHits }
            );
            emit(closeT, ++syntheticOrder, cpuTrack, 2, undefined, {}, {}, 0);
          }
        };

        for (let i = 0; i < cpu.samples.length; i++) {
          const rawStart = cpu.timestampsMs[i];
          const rawNext = i + 1 < cpu.timestampsMs.length ? Math.max(rawStart, cpu.timestampsMs[i + 1]) : rawStart + defaultStepMs;
          const sampleDurLocal = Math.max(0.001, rawNext - rawStart);
          const t = Math.max(prevT, tsArray[i]);
          prevT = t;
          const stack = getStackPath(cpu.samples[i]);
          let commonPrefix = 0;
          while (commonPrefix < openFrames.length && commonPrefix < stack.length && openFrames[commonPrefix].node.id === stack[commonPrefix].id) {
            commonPrefix++;
          }
          closeDownTo(commonPrefix, t, rawStart);
          for (let d = commonPrefix; d < stack.length; d++) {
            const node = stack[d];
            const beginEvent = emit(t, ++syntheticOrder, cpuTrack, 1, node.functionName, {
              sourceId: s.sourceId,
              streamId: s.streamId,
              buildId: s.build.id,
              lumioKind: 'cpu-sample',
              measurementKind: 'sampled-wall',
              collector: cpu.collector,
              sourceFile: node.url,
              sourceLine: node.lineNumber
            }, {}, 1);
            openFrames.push({ node, startT: t, localStartMs: rawStart, selfMs: 0, leafHits: 0, beginEvent });
          }
          if (openFrames.length > 0) {
            const leaf = openFrames[openFrames.length - 1];
            leaf.selfMs += sampleDurLocal;
            leaf.leafHits += 1;
          }
        }
        if (openFrames.length > 0) {
          const lastIdx = cpu.samples.length - 1;
          const finalLocalMs = cpu.timestampsMs[lastIdx] + defaultStepMs;
          const finalT = Math.max(prevT, tsArray[lastIdx] + defaultStepMs);
          closeDownTo(0, finalT, finalLocalMs);
        }
      }

      // Emit stats: either time-series curve (when statSeries exists) or stop-time summary point.
      const series = analysis.statSeriesByStream.get(s.streamId);
      if (series?.length) {
        const byMarker = new Map<number, typeof series>();
        for (const pt of series) {
          let arr = byMarker.get(pt.markerId);
          if (!arr) { arr = []; byMarker.set(pt.markerId, arr); }
          arr.push(pt);
        }
        for (const stat of s.stats) {
          const marker = markerById.get(stat.markerId)!;
          const uuid = track(`${s.streamId}/counter/${stat.markerId}`, marker.name, root, true);
          const pts = byMarker.get(stat.markerId) ?? [];
          for (let i = 0; i < pts.length; i++) {
            const pt = pts[i];
            const ptTime = isLocal ? pt.time : (pt.mappedTime ?? pt.time);
            const isLast = i === pts.length - 1;
            emit(ptTime, ++syntheticOrder, uuid, 4, undefined, isLast ? {
              lumioKind: 'stats',
              windowStartMs: s.startedAt,
              windowEndMs: s.stoppedAt,
              unit: marker.unit,
              count: stat.count,
              sum: stat.sum,
              min: stat.min,
              max: stat.max,
              buckets: JSON.stringify(stat.buckets)
            } : {
              lumioKind: 'stats-sample',
              unit: marker.unit,
              count: pt.count,
              sum: pt.sum
            }, { doubleCounterValue: marker.kind === 'histogram' ? pt.count : pt.value });
          }
        }
      } else {
        for (const stat of s.stats) {
          const marker = markerById.get(stat.markerId)!;
          const uuid = track(`${s.streamId}/counter/${stat.markerId}`, marker.name, root, true);
          const stopT = isLocal ? s.stoppedAt : (earliest > 0 ? earliest + Math.max(0, s.stoppedAt - s.startedAt) : s.stoppedAt);
          emit(stopT, 0, uuid, 4, undefined, {
            lumioKind: 'stats',
            windowStartMs: s.startedAt,
            windowEndMs: s.stoppedAt,
            unit: marker.unit,
            count: stat.count,
            sum: stat.sum,
            min: stat.min,
            max: stat.max,
            buckets: JSON.stringify(stat.buckets)
          }, { doubleCounterValue: marker.kind === 'histogram' ? stat.count : stat.value });
        }
      }
    }

    for (let i = 0; i < analysis.relations.length; i++) {
      const r = analysis.relations[i];
      if (r.from && r.to && sourceStreams.has(r.from.streamId) && sourceStreams.has(r.to.streamId) && r.durationMs !== null && time(r.to) >= time(r.from)) {
        const uuid = track(`relation/${r.key}`, `${r.measurementKind}: ${r.key}`);
        emit(time(r.from), r.from.seq, uuid, 1, r.measurementKind, {
          lumioKind: 'relation',
          measurementKind: r.measurementKind,
          correlationKey: r.key,
          operationKey: r.from.context?.operationKey ?? r.to.context?.operationKey,
          localDurationMs: r.durationMs,
          uncertaintyMs: r.uncertaintyMs,
          timing: r.timing,
          evidence: r.evidence.join('|')
        });
        emit(time(r.to), r.to.seq, uuid, 2);
      }
    }

    timed.sort((a, b) => a.t - b.t || a.phase - b.phase || a.order - b.order);

    // Loop minimum instead of Math.min(...spread) so 150k-1M events never overflow the JS call stack.
    let base = Infinity;
    if (isLocal) {
      for (let i = 0; i < sources.length; i++) if (sources[i].startedAt < base) base = sources[i].startedAt;
    }
    for (let i = 0; i < timed.length; i++) {
      if (timed[i].t < base) base = timed[i].t;
    }
    if (!Number.isFinite(base)) base = 0;

    const ns = (t: number) => BigInt(Math.max(1, Math.round((t - base) * 1e6 + 1))).toString();
    // Timestamps are already normalized to this file's synthetic axis. Use the
    // default trace clock, as in Perfetto's custom-data converter examples.
    for (let i = 0; i < timed.length; i++) {
      const p = timed[i];
      packets.push({ timestamp: ns(p.t), trustedPacketSequenceId: 1, trackEvent: p.event });
    }
    const object = Trace.fromObject({ packet: packets });
    const error = Trace.verify(object);
    if (error) throw new Error(error);
    results.push({
      domain,
      ...(Object.keys(fallbackReasons).length ? { fallbackReasons } : {}),
      bytes: Trace.encode(object).finish(),
      sourceIds: sources.map(s => s.sourceId)
    });
  }
  return results;
}
