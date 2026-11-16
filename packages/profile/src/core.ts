import type {
  Options, CaptureConfig, Context, Marker, Snapshot, Quality, StatData, StatSampleData,
  RecordData, ControlChannel, ControlRequest, FaultInfo, AutoRecordData, CpuProfileData,
  CollectorSessionHandle, ConnectOptions, ConnectionHandle
} from './types.ts';
import { connect as connectTransport } from './transport.ts';
export type * from './types.ts';

// Compact storage reservation: 64 bytes numeric columns + 16 bytes variable-length UTF-16
// ring pool per slot (~104,652 records in an 8 MiB buffer vs 8,162 previously).
const BASE_BYTES = 8192;
const TRACE_DICT_BASE_BYTES = 4096;
const TRACE_SLOT_BYTES = 80;
const BASE_TEXT_UNITS = 2048;
const TEXT_UNITS_PER_SLOT = 8;
const KEY_CHARS = 96;
const FIELD_CHARS = 24;
const GEN_STRIDE = 0x40000000; // 2^30 spans/session; fits with >8M generations in IEEE-754 safe int
const KIND = ['begin', 'end', 'event', 'link'] as const;
const copyConfig = (c: Snapshot['config']): Snapshot['config'] => ({
  ...c,
  markerIds: c.markerIds?.slice(),
  collectors: c.collectors ? { ...c.collectors } : undefined
});

/** Deduplicates or merges multiple marker catalogs (e.g. Engine + Game markers), rejecting ID collisions with mismatched definitions. */
export function mergeMarkers(...catalogs: readonly (readonly Marker[])[]): Marker[] {
  const byId = new Map<number, Marker>();
  for (const list of catalogs) {
    for (const m of list) {
      const prior = byId.get(m.id);
      if (prior) {
        if (prior.name !== m.name || prior.kind !== m.kind) {
          throw new Error(`conflicting-marker-id:${m.id} (${prior.name}/${prior.kind} vs ${m.name}/${m.kind})`);
        }
        continue;
      }
      byId.set(m.id, { ...m, fields: m.fields?.slice(), buckets: m.buckets?.slice(), source: m.source ? { ...m.source } : undefined });
    }
  }
  return [...byId.values()];
}

export function createProfiler(options: Options) {
  options = { ...options, build: { ...options.build }, environment: { ...options.environment } };
  const { host, clock, scheduler } = options;
  const policy = {
    maxBytes: 8 * 1024 * 1024,
    maxDurationMs: 300000,
    maxOpenSpans: 128,
    allowCpuSampling: true,
    ...options.policy
  };
  const catalog = new Map<number, Marker>();
  const validationErrors: string[] = [];
  if (host?.contract !== 'lumio.observation/1') validationErrors.push(`host.contract: expected 'lumio.observation/1', got '${String((host as any)?.contract)}'`);
  if (!options.sourceId || typeof options.sourceId !== 'string') validationErrors.push('sourceId: required non-empty string');
  if (!options.role || typeof options.role !== 'string') validationErrors.push('role: required non-empty string');
  if (!Array.isArray(options.markers)) {
    validationErrors.push('markers: expected array');
  } else {
    if (options.markers.length > 256) validationErrors.push(`markers: length ${options.markers.length} exceeds max 256`);
    options.markers.slice(0, 256).forEach((m, idx) => {
      const label = `marker[${idx}] (id=${String(m?.id)}, name=${JSON.stringify(m?.name ?? '')})`;
      if (!m || typeof m !== 'object') { validationErrors.push(`${label}: must be an object`); return; }
      if (!Number.isInteger(m.id) || m.id < 1) validationErrors.push(`${label}: id must be a positive integer >= 1`);
      else if (catalog.has(m.id)) validationErrors.push(`${label}: duplicate marker id ${m.id} (already used by '${catalog.get(m.id)!.name}')`);
      if (typeof m.name !== 'string' || m.name.length === 0 || m.name.length > 128) validationErrors.push(`${label}: name length must be 1..128`);
      if (!['span', 'event', 'link', 'counter', 'gauge', 'histogram'].includes(m.kind)) validationErrors.push(`${label}: invalid kind '${String(m.kind)}'`);
      if ((m.fields?.length ?? 0) > 4) validationErrors.push(`${label}: fields count ${m.fields!.length} exceeds max 4`);
      if ((m.buckets?.length ?? 0) > 32) validationErrors.push(`${label}: buckets count ${m.buckets!.length} exceeds max 32`);
      if (m.buckets?.some((b, bi) => !Number.isFinite(b) || (bi > 0 && b <= m.buckets![bi - 1]))) {
        validationErrors.push(`${label}: histogram buckets must be strictly ascending finite numbers`);
      }
      if (Number.isInteger(m.id) && m.id >= 1 && !catalog.has(m.id)) {
        catalog.set(m.id, { ...m, fields: m.fields?.slice(), buckets: m.buckets?.slice(), source: m.source ? { ...m.source } : undefined });
      }
    });
  }
  if (!Number.isInteger(policy.maxOpenSpans) || policy.maxOpenSpans! > 4096 || policy.maxOpenSpans! < 1) {
    validationErrors.push(`policy.maxOpenSpans: ${String(policy.maxOpenSpans)} must be an integer within 1..4096`);
  }
  const valid = validationErrors.length === 0;

  let serial = 0, active = false, generation = 0;
  let plan: { token: string; config: Snapshot['config'] } | undefined;
  let session: ReturnType<typeof makeSession> | undefined;
  let lastRequest: { requestId: string; captureId: string; result: any } | undefined;
  let lastFault: FaultInfo | undefined;

  function minBytesForMode(mode: CaptureConfig['mode']) {
    if (mode === 'stats') return BASE_BYTES + policy.maxOpenSpans! * 32 + catalog.size * 512;
    const statBytes = mode === 'hybrid' ? catalog.size * 512 : 0;
    return BASE_BYTES + TRACE_DICT_BASE_BYTES + policy.maxOpenSpans! * 32 + statBytes + TRACE_SLOT_BYTES;
  }

  function makeSession(config: Snapshot['config'], captureId: string, requestId: string) {
    const hasTrace = config.mode === 'trace' || config.mode === 'hybrid';
    const hasStats = config.mode === 'stats' || config.mode === 'hybrid';
    const statBytes = hasStats ? catalog.size * 512 : 0;
    const overhead = BASE_BYTES + (hasTrace ? TRACE_DICT_BASE_BYTES : 0) + policy.maxOpenSpans! * 32 + statBytes;
    const capacity = hasTrace ? Math.max(1, Math.floor((config.maxBytes - overhead) / TRACE_SLOT_BYTES)) : 0;
    const textCap = hasTrace ? BASE_TEXT_UNITS + capacity * TEXT_UNITS_PER_SLOT : 0;
    const numbers = new Float64Array(capacity * 8);
    const texts = new Uint16Array(textCap);
    const spans = new Float64Array(policy.maxOpenSpans! * 3);
    const asyncSpans = new Map<number, number>();
    const stats = new Map<number, { data: StatData; marker: Marker }>();
    const statSeries: StatSampleData[] = [];
    if (hasStats) for (const m of catalog.values()) {
      if (['counter', 'gauge', 'histogram'].includes(m.kind)) stats.set(m.id, { marker: m,
        data: { markerId: m.id, value: 0, count: 0, sum: 0, min: null, max: null, buckets: new Array((m.buckets?.length ?? 0) + 1).fill(0) } });
    }
    const quality: Quality = { dropped: 0, overwritten: 0, invalid: 0, filtered: 0, openSpans: 0, tail: 'unknown', reason: 'running', lastAttemptedSeq: 0, detail: 'complete' };
    const startedAt = clock.now();
    if (!Number.isFinite(startedAt)) throw new Error('clock-fault');
    return {
      config, captureId, requestId, streamId: `${options.sourceId}/${++serial}`,
      numbers, texts, textCap, textWrite: 0, spans, asyncSpans, stats, statSeries, quality,
      capacity, head: 0, length: 0, seq: 0, depth: 0, spanSerial: 0,
      startedAt, lastTime: startedAt, stoppedAt: startedAt,
      allocatedBytes: overhead + capacity * TRACE_SLOT_BYTES,
      timer: undefined as unknown, statsTimer: undefined as unknown,
      collectorHandle: undefined as CollectorSessionHandle | undefined,
      pendingCollectorStop: undefined as Promise<void> | undefined,
      autoRecords: undefined as AutoRecordData[] | undefined,
      cpuProfile: undefined as CpuProfileData | undefined,
      collectorStatus: undefined as Record<string, string> | undefined,
      scratchTags: new Uint16Array(8),
      scratchStrings: ['', '', '', '', '', '', '', ''],
      selected: config.markerIds ? new Set(config.markerIds) : undefined
    };
  }

  function inspect() {
    return {
      protocol: 'lumio.control/1',
      sourceId: options.sourceId,
      role: options.role,
      build: options.build,
      supported: valid,
      validationErrors: validationErrors.slice(),
      invalidReason: validationErrors[0],
      lastFault: lastFault ? { ...lastFault } : undefined,
      mode: active ? session?.config.mode : 'off',
      environment: { ...options.environment, ...(clock.precisionMs !== undefined ? { clockResolutionMs: clock.precisionMs } : {}) },
      capabilities: {
        stats: true, trace: true, hybrid: true, asyncSpans: true, drain: true,
        nativeCpu: false, gpu: false, physicalPresent: false,
        ...(options.collectorAdapter?.capabilities ?? {})
      },
      policy: { ...policy }
    };
  }

  function prepare(input: CaptureConfig) {
    if (!valid) return { ok: false as const, error: 'incompatible-host-or-catalog', reasons: validationErrors.slice() };
    if (active || host.trace || host.stats) return { ok: false as const, error: 'busy' };
    if (options.build.mode === 'release' && !policy.allowRelease) return { ok: false as const, error: 'release-disabled' };
    if (!input || !['stats', 'trace', 'hybrid'].includes(input.mode) || !Number.isFinite(input.durationMs) || input.durationMs <= 0) {
      return { ok: false as const, error: 'invalid-duration-or-mode' };
    }
    const durationMs = Math.min(input.durationMs, policy.maxDurationMs!);
    const rawBytes = input.maxBytes ?? Math.min(policy.maxBytes!, 8 * 1024 * 1024);
    if (!Number.isInteger(rawBytes) || rawBytes <= 0) return { ok: false as const, error: 'invalid-capacity' };
    const maxBytes = Math.min(rawBytes, policy.maxBytes!);
    if (maxBytes < minBytesForMode(input.mode)) return { ok: false as const, error: 'invalid-capacity' };
    if (input.overflowPolicy && !['drop-new-detail', 'overwrite-oldest-chunk'].includes(input.overflowPolicy)) return { ok: false as const, error: 'invalid-overflow-policy' };
    if (input.markerIds && (input.markerIds.length > 256 || input.markerIds.some(id => !catalog.has(id)))) return { ok: false as const, error: 'invalid-filter' };
    if (input.statsIntervalMs !== undefined && (!Number.isFinite(input.statsIntervalMs) || input.statsIntervalMs < 10)) return { ok: false as const, error: 'invalid-stats-interval' };
    plan = {
      token: `${options.sourceId}/plan/${++serial}`,
      config: {
        mode: input.mode,
        durationMs,
        maxBytes,
        overflowPolicy: input.overflowPolicy ?? 'drop-new-detail',
        markerIds: input.markerIds?.slice(),
        collectors: input.collectors ? { ...input.collectors } : undefined,
        statsIntervalMs: input.statsIntervalMs
      }
    };
    return { ok: true as const, token: plan.token, config: copyConfig(plan.config) };
  }

  function sampleStatsSeries(s: NonNullable<typeof session>, time: number) {
    if (s.statSeries.length >= 16384) return;
    for (const { data } of s.stats.values()) {
      if (s.selected && !s.selected.has(data.markerId)) continue;
      if (s.statSeries.length >= 16384) break;
      s.statSeries.push({ time, markerId: data.markerId, value: data.value, count: data.count, sum: data.sum });
    }
  }

  function applyCollectorResult(s: NonNullable<typeof session>, res: { autoRecords?: AutoRecordData[]; cpuProfile?: CpuProfileData; status: Record<string, string>; autoDropped?: number }) {
    if (res.autoRecords?.length) s.autoRecords = res.autoRecords;
    if (res.cpuProfile) s.cpuProfile = res.cpuProfile;
    if (Object.keys(res.status).length) s.collectorStatus = res.status;
    if (res.autoDropped) s.quality.autoDropped = (s.quality.autoDropped ?? 0) + res.autoDropped;
  }

  function stop(reason = 'requested') {
    if (!active || !session) return status();
    const s = session;
    active = false;
    host.trace = undefined; host.stats = undefined;
    try { scheduler.clear(s.timer); } catch { /* A failed timer cleanup cannot affect the host. */ }
    if (s.statsTimer !== undefined) { try { scheduler.clear(s.statsTimer); } catch {} s.statsTimer = undefined; }
    s.quality.openSpans = s.depth + s.asyncSpans.size;
    s.quality.tail = 'complete';
    s.quality.reason = reason;
    if (reason === 'clock-fault' || reason === 'writer-fault' || reason === 'scheduler-fault') {
      s.quality.detail = 'partial';
      lastFault = { reason, captureId: s.captureId, streamId: s.streamId };
      try { options.onFault?.({ ...lastFault }); } catch { /* diagnostic callback cannot throw into host */ }
    }
    try { const t = clock.now(); if (Number.isFinite(t) && t >= s.lastTime) s.stoppedAt = t; } catch { /* preserve last known time */ }
    if (s.config.statsIntervalMs || (s.config.mode === 'hybrid' && s.stats.size > 0)) {
      sampleStatsSeries(s, s.stoppedAt);
    }
    if (s.collectorHandle) {
      const handle = s.collectorHandle;
      s.collectorHandle = undefined;
      try {
        const stopped = handle.stop();
        if (stopped && typeof (stopped as Promise<any>).then === 'function') {
          s.pendingCollectorStop = (stopped as Promise<any>).then(r => applyCollectorResult(s, r)).catch(() => {
            s.collectorStatus = { ...s.collectorStatus, collectorStopError: 'failed' };
          });
        } else if (stopped) {
          applyCollectorResult(s, stopped as any);
        }
      } catch {
        s.collectorStatus = { ...s.collectorStatus, collectorStopError: 'failed' };
      }
    }
    try { options.onStateChange?.({ active: false, mode: 'off', reason, captureId: s.captureId }); } catch {}
    return status();
  }

  async function stopAsync(reason = 'requested') {
    const result = stop(reason);
    if (session?.pendingCollectorStop) await session.pendingCollectorStop;
    return status() ?? result;
  }

  function status() {
    const hasStats = session && (session.config.mode === 'stats' || session.config.mode === 'hybrid');
    return {
      sourceId: options.sourceId,
      active,
      mode: active ? session?.config.mode : 'off',
      captureId: session?.captureId,
      streamId: session?.streamId,
      capacity: session?.capacity ?? 0,
      allocatedBytes: session?.allocatedBytes ?? 0,
      retainedRecords: session?.length ?? 0,
      stats: hasStats ? [...session!.stats.values()].map(({ data: v }) => ({ ...v, buckets: v.buckets.slice() })) : undefined,
      reason: session?.quality.reason ?? 'off',
      lastFault: lastFault ? { ...lastFault } : undefined,
      config: session ? copyConfig(session.config) : undefined,
      quality: session ? { ...session.quality } : undefined
    };
  }

  function release() {
    if (active) return { ok: false, error: 'stop-before-release' };
    if (session) {
      session.numbers = new Float64Array(0);
      session.texts = new Uint16Array(0);
      session.spans = new Float64Array(0);
      session.asyncSpans.clear();
      session.stats.clear();
      session.statSeries.length = 0;
      session.autoRecords = undefined;
      session.cpuProfile = undefined;
    }
    session = undefined;
    return { ok: true };
  }

  function start(input: { token: string; requestId: string; captureId: string }) {
    if (lastRequest?.requestId === input.requestId) return lastRequest.captureId === input.captureId ? lastRequest.result : { ok: false, error: 'request-conflict' };
    if (active || host.trace || host.stats) return { ok: false, error: 'busy' };
    if (!plan || input.token !== plan.token || !input.requestId || !input.captureId || input.captureId.length > 128) return { ok: false, error: 'invalid-plan' };
    release();
    try { session = makeSession(plan.config, input.captureId, input.requestId); } catch { return { ok: false, error: 'allocation-or-clock-fault' }; }
    plan = undefined; active = true;
    const s = session, ownGeneration = ++generation;
    const maxAsyncSpans = policy.maxOpenAsyncSpans ?? policy.maxOpenSpans!;
    function live() { return active && generation === ownGeneration; }
    function drop(seq: number) {
      s.quality.dropped++; s.quality.detail = 'partial';
      s.quality.firstDroppedSeq ??= seq; s.quality.lastDroppedSeq = seq;
    }
    function validateStr(value: string | undefined, max: number) {
      if (value === undefined) return false;
      if (typeof value !== 'string' || value.length >= max || value.includes('\0')) throw new Error('field-length-or-terminator');
      return value.length > 0;
    }
    // Capture accepts plain data only. No stringify, network or native export on this path.
    function record(kind: number, markerId: number, context?: Context, spanId = 0, parent = 0, correlation?: string, side?: 'out' | 'in', isAsync = false) {
      if (!live()) return false;
      const m = catalog.get(markerId);
      if (!m || m.kind !== (kind < 2 ? 'span' : kind === 2 ? 'event' : 'link')) { s.quality.invalid++; s.quality.detail = 'partial'; return false; }
      if (s.selected && !s.selected.has(markerId)) { s.quality.filtered++; return false; }
      const reservedEnds = Math.min(16, Math.floor(s.capacity / 8));
      const limit = kind === 1 ? s.capacity : Math.max(1, s.capacity - reservedEnds);
      // Fast reject before clock.now() when drop-new-detail buffer is already full.
      if (s.length >= limit && s.config.overflowPolicy === 'drop-new-detail') {
        const seq = ++s.seq; s.quality.lastAttemptedSeq = seq;
        drop(seq);
        return false;
      }
      const time = clock.now();
      if (!Number.isFinite(time) || time < s.lastTime) { stop('clock-fault'); return false; }
      if (time - s.startedAt >= s.config.durationMs) { s.lastTime = time; s.stoppedAt = time; stop('deadline'); return false; }
      s.lastTime = time; s.stoppedAt = time;
      const seq = ++s.seq; s.quality.lastAttemptedSeq = seq;

      // Validate all context/fields BEFORE evicting ring chunks or writing slot data.
      let entryCount = 0;
      let neededUnits = 0;
      try {
        if (context?.tick !== undefined && !Number.isSafeInteger(context.tick)) throw new Error('tick');
        if (context || correlation !== undefined) {
          const op = context?.operationKey;
          if (validateStr(op, KEY_CHARS)) { s.scratchTags[entryCount] = 0; s.scratchStrings[entryCount] = op!; neededUnits += 2 + op!.length; entryCount++; }
          const ent = context?.entityKey;
          if (validateStr(ent, KEY_CHARS)) { s.scratchTags[entryCount] = 1; s.scratchStrings[entryCount] = ent!; neededUnits += 2 + ent!.length; entryCount++; }
          if (validateStr(correlation, KEY_CHARS)) { s.scratchTags[entryCount] = 2; s.scratchStrings[entryCount] = correlation!; neededUnits += 2 + correlation!.length; entryCount++; }
          const fieldNames = m.fields;
          if (fieldNames && context?.fields) {
            for (let i = 0; i < fieldNames.length; i++) {
              const value = context.fields[fieldNames[i]];
              if (value !== undefined) {
                const vt = typeof value;
                if ((vt !== 'number' && vt !== 'string' && vt !== 'boolean') || (vt === 'number' && !Number.isFinite(value))) throw new Error('field-type');
                const encoded = `${vt === 'number' ? 'n' : vt === 'boolean' ? 'b' : 's'}${value}`;
                if (validateStr(encoded, FIELD_CHARS)) { s.scratchTags[entryCount] = 3 + i; s.scratchStrings[entryCount] = encoded; neededUnits += 2 + encoded.length; entryCount++; }
              }
            }
          }
          if (entryCount > 0) neededUnits += 1;
          if (neededUnits > s.textCap) throw new Error('text-budget');
        }
      } catch {
        for (let k = 0; k < entryCount; k++) s.scratchStrings[k] = '';
        s.quality.invalid++;
        drop(seq);
        return false;
      }

      if (s.length >= limit) {
        // v1 chunks contain at most 16 slots; discard a whole oldest chunk only after validation succeeds.
        const removed = Math.min(16, s.length);
        s.head = (s.head + removed) % s.capacity; s.length -= removed;
        s.quality.overwritten += removed; s.quality.detail = 'partial';
      }

      let textStart = -1;
      if (entryCount > 0) {
        let pos = s.textWrite % s.textCap;
        if (pos + neededUnits > s.textCap) {
          s.textWrite += s.textCap - pos;
          pos = 0;
        }
        textStart = s.textWrite;
        s.texts[pos++] = entryCount;
        for (let k = 0; k < entryCount; k++) {
          const str = s.scratchStrings[k];
          s.scratchStrings[k] = '';
          s.texts[pos++] = s.scratchTags[k];
          s.texts[pos++] = str.length;
          for (let c = 0; c < str.length; c++) s.texts[pos++] = str.charCodeAt(c);
        }
        s.textWrite += neededUnits;
      }

      const slot = (s.head + s.length) % s.capacity, n = slot * 8;
      const sideCode = side === 'out' ? 1 : side === 'in' ? 2 : 0;
      const flags = kind | (sideCode << 2) | (isAsync ? 16 : 0) | (neededUnits << 5);
      s.numbers[n] = seq;
      s.numbers[n + 1] = time;
      s.numbers[n + 2] = flags;
      s.numbers[n + 3] = markerId;
      s.numbers[n + 4] = spanId;
      s.numbers[n + 5] = parent;
      s.numbers[n + 6] = context?.tick ?? NaN;
      s.numbers[n + 7] = textStart;
      s.length++;
      return true;
    }

    if (s.config.mode === 'trace' || s.config.mode === 'hybrid') host.trace = {
      begin(id, context) {
        if (!live()) return 0;
        try {
          if (s.depth >= policy.maxOpenSpans!) { s.quality.invalid++; s.quality.detail = 'partial'; return 0; }
          if (s.spanSerial >= GEN_STRIDE - 1) { s.quality.invalid++; s.quality.detail = 'partial'; return 0; }
          const token = ownGeneration * GEN_STRIDE + (++s.spanSerial);
          const parent = s.depth ? s.spans[(s.depth - 1) * 3] : 0;
          if (!record(0, id, context, token, parent)) return 0;
          const n = s.depth++ * 3; s.spans[n] = token; s.spans[n + 1] = id; s.spans[n + 2] = parent;
          return token;
        } catch { stop('writer-fault'); return 0; }
      },
      end(token) {
        if (!live() || !token) return;
        try {
          if (!Number.isSafeInteger(token) || token < 1) { s.quality.invalid++; s.quality.detail = 'partial'; return; }
          const tokenGen = Math.floor(token / GEN_STRIDE);
          // Late end from an earlier session re-reading host.trace: reject safely without corrupting the new session.
          if (tokenGen >= 1 && tokenGen < ownGeneration) return;
          if (tokenGen !== ownGeneration || s.depth === 0) { s.quality.invalid++; s.quality.detail = 'partial'; return; }
          const top = (s.depth - 1) * 3;
          if (s.spans[top] === token) {
            record(1, s.spans[top + 1], undefined, token, s.spans[top + 2]);
            s.depth--;
            return;
          }
          // Non-LIFO recovery: if an inner span missed its end(), pop unclosed inner spans and mark incomplete.
          for (let k = s.depth - 2; k >= 0; k--) {
            if (s.spans[k * 3] === token) {
              const leaked = s.depth - 1 - k;
              s.quality.invalid += leaked;
              s.quality.unclosedSpans = (s.quality.unclosedSpans ?? 0) + leaked;
              s.quality.detail = 'partial';
              s.depth = k;
              record(1, s.spans[k * 3 + 1], undefined, token, s.spans[k * 3 + 2]);
              return;
            }
          }
          s.quality.invalid++; s.quality.detail = 'partial';
        } catch { stop('writer-fault'); }
      },
      beginAsync(id, context) {
        if (!live()) return 0;
        try {
          if (s.asyncSpans.size >= maxAsyncSpans || s.spanSerial >= GEN_STRIDE - 1) { s.quality.invalid++; s.quality.detail = 'partial'; return 0; }
          const token = ownGeneration * GEN_STRIDE + (++s.spanSerial);
          if (!record(0, id, context, token, 0, undefined, undefined, true)) return 0;
          s.asyncSpans.set(token, id);
          return token;
        } catch { stop('writer-fault'); return 0; }
      },
      endAsync(token, context) {
        if (!live() || !token) return;
        try {
          if (!Number.isSafeInteger(token) || token < 1) { s.quality.invalid++; s.quality.detail = 'partial'; return; }
          const tokenGen = Math.floor(token / GEN_STRIDE);
          if (tokenGen >= 1 && tokenGen < ownGeneration) return;
          const markerId = s.asyncSpans.get(token);
          if (tokenGen !== ownGeneration || markerId === undefined) { s.quality.invalid++; s.quality.detail = 'partial'; return; }
          s.asyncSpans.delete(token);
          record(1, markerId, context, token, 0, undefined, undefined, true);
        } catch { stop('writer-fault'); }
      },
      event(id, context) { if (live()) try { record(2, id, context); } catch { stop('writer-fault'); } },
      link(id, key, side, context) { if (live()) try { record(3, id, context, 0, 0, key, side); } catch { stop('writer-fault'); } }
    };

    if (s.config.mode === 'stats' || s.config.mode === 'hybrid') {
      function update(id: number, value: number, kind: string) {
        if (!live()) return;
        // The immutable marker is resolved once at capture start, not on every update.
        const entry = s.stats.get(id);
        if (s.selected && !s.selected.has(id)) return;
        if (!entry || !Number.isFinite(value) || entry.marker.kind !== kind) { s.quality.invalid++; return; }
        const { data: stat, marker: m } = entry;
        if (kind === 'counter') stat.value += value;
        else if (kind === 'gauge') stat.value = value;
        else {
          stat.count++; stat.sum += value; stat.min = stat.min === null ? value : Math.min(stat.min, value); stat.max = stat.max === null ? value : Math.max(stat.max, value);
          let b = 0; while (b < (m.buckets?.length ?? 0) && value > m.buckets![b]) b++; stat.buckets[b]++;
        }
      }
      host.stats = { add: (id, v) => update(id, v, 'counter'), gauge: (id, v) => update(id, v, 'gauge'), observe: (id, v) => update(id, v, 'histogram') };
      const seriesMs = s.config.statsIntervalMs ?? (s.config.mode === 'hybrid' && s.stats.size > 0 ? 250 : undefined);
      if (seriesMs) {
        sampleStatsSeries(s, s.startedAt);
        const tickStats = () => {
          if (!live()) return;
          try {
            const now = clock.now();
            if (Number.isFinite(now)) sampleStatsSeries(s, now);
            s.statsTimer = scheduler.set(tickStats, seriesMs);
          } catch { /* ignore series sampling fault */ }
        };
        try { s.statsTimer = scheduler.set(tickStats, seriesMs); } catch {}
      }
    }

    if (s.config.collectors && options.collectorAdapter) {
      try { s.collectorHandle = options.collectorAdapter.start(s.config.collectors, policy); }
      catch { s.collectorStatus = { collectorStartError: 'failed' }; }
    }

    try { s.timer = scheduler.set(() => { if (live()) stop('deadline'); }, s.config.durationMs); }
    catch { stop('scheduler-fault'); return { ok: false, error: 'scheduler-fault' }; }
    try { options.onStateChange?.({ active: true, mode: s.config.mode, reason: 'running', captureId: s.captureId }); } catch {}
    const result = { ok: true, captureId: s.captureId, streamId: s.streamId, startedAt: s.startedAt, config: copyConfig(s.config) };
    lastRequest = { requestId: input.requestId, captureId: input.captureId, result };
    return result;
  }

  function decodeRecords(s: NonNullable<typeof session>, offset: number, until: number): RecordData[] {
    const records: RecordData[] = [];
    for (let i = offset; i < until; i++) {
      const slot = (s.head + i) % s.capacity, n = slot * 8;
      const flags = s.numbers[n + 2];
      const kindIdx = flags & 3;
      const sideCode = (flags >> 2) & 3;
      const isAsync = ((flags >> 4) & 1) === 1;
      const textLen = flags >>> 5;
      const markerId = s.numbers[n + 3];
      const m = catalog.get(markerId)!;
      const context: Context = { operationKey: undefined, entityKey: undefined };
      let correlationKey: string | undefined;
      if (Number.isFinite(s.numbers[n + 6])) context.tick = s.numbers[n + 6];
      if (textLen > 0) {
        const textStart = s.numbers[n + 7];
        if (textStart >= 0 && s.textWrite - textStart <= s.textCap) {
          let pos = textStart % s.textCap;
          const count = s.texts[pos++];
          let fields: Record<string, string | number | boolean> | undefined;
          for (let k = 0; k < count; k++) {
            const tag = s.texts[pos++];
            const len = s.texts[pos++];
            let str = '';
            for (let c = 0; c < len; c++) str += String.fromCharCode(s.texts[pos++]);
            if (tag === 0) context.operationKey = str;
            else if (tag === 1) context.entityKey = str;
            else if (tag === 2) correlationKey = str;
            else if (m.fields && tag - 3 < m.fields.length) {
              fields ??= {};
              fields[m.fields[tag - 3]] = str[0] === 'n' ? Number(str.slice(1)) : str[0] === 'b' ? str.slice(1) === 'true' : str.slice(1);
            }
          }
          if (fields) context.fields = fields;
        } else {
          s.quality.detail = 'partial';
        }
      }
      const rec: RecordData = {
        seq: s.numbers[n],
        time: s.numbers[n + 1],
        kind: KIND[kindIdx],
        markerId,
        spanId: s.numbers[n + 4] || undefined,
        parentSpanId: s.numbers[n + 5] || undefined,
        correlationKey,
        side: sideCode === 1 ? 'out' : sideCode === 2 ? 'in' : undefined,
        context
      };
      if (isAsync) rec.async = true;
      records.push(rec);
    }
    return records;
  }

  function drain(ackSeq = 0, limit = 512) {
    if (!session) throw new Error('no-capture');
    const s = session;
    if (!Number.isSafeInteger(ackSeq) || ackSeq < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid-drain-window');
    while (s.length > 0 && s.numbers[s.head * 8] <= ackSeq) {
      s.head = (s.head + 1) % s.capacity;
      s.length--;
    }
    const count = Math.min(s.length, Math.min(limit, 1024));
    const records = decodeRecords(s, 0, count);
    return {
      ok: true as const,
      captureId: s.captureId,
      streamId: s.streamId,
      active,
      records,
      lastSeq: records.length ? records[records.length - 1].seq : ackSeq,
      remaining: s.length - records.length
    };
  }

  function snapshot(offset = 0, limit = Number.MAX_SAFE_INTEGER): Snapshot & { window: { offset: number; total: number; next: number | null } } {
    if (active) throw new Error('stop-before-export');
    if (!session) throw new Error('no-capture');
    const s = session;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > s.length || !Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid-export-window');
    const until = Math.min(s.length, offset + limit);
    const records = decodeRecords(s, offset, until);
    const { now: _, ...clockInfo } = clock;
    const env = { ...options.environment, ...(clock.precisionMs !== undefined ? { clockResolutionMs: clock.precisionMs } : {}) };
    const snap: Snapshot & { window: { offset: number; total: number; next: number | null } } = {
      protocol: 'lumio.capture/1',
      captureId: s.captureId,
      streamId: s.streamId,
      sourceId: options.sourceId,
      role: options.role,
      build: { ...options.build },
      clock: { ...clockInfo },
      environment: env,
      config: copyConfig(s.config),
      startedAt: s.startedAt,
      stoppedAt: s.stoppedAt,
      allocatedBytes: s.allocatedBytes,
      markers: [...catalog.values()],
      records,
      stats: [...s.stats.values()].map(({ data: v }) => ({ ...v, buckets: v.buckets.slice() })),
      quality: { ...s.quality },
      window: { offset, total: s.length, next: until < s.length ? until : null }
    };
    if (offset === 0) {
      if (s.autoRecords?.length) snap.autoRecords = s.autoRecords.slice();
      if (s.cpuProfile) snap.cpuProfile = s.cpuProfile;
      if (s.collectorStatus) snap.collectorStatus = { ...s.collectorStatus };
      if (s.statSeries.length) snap.statSeries = s.statSeries.slice();
    }
    return snap;
  }

  function readClock() {
    // Allow calibration reads both while running and while a stopped session is awaiting export; never when Off.
    if (!active && !session) return { ok: false, error: 'off' };
    try {
      const time = clock.now();
      return Number.isFinite(time)
        ? { ok: true, clockId: clock.id, clockEpoch: clock.epoch, precisionMs: clock.precisionMs, time }
        : { ok: false, error: 'clock-fault' };
    } catch { return { ok: false, error: 'clock-fault' }; }
  }

  function attachControl(channel: ControlChannel) {
    return channel.subscribe((request: ControlRequest) => {
      try {
        if (['stop', 'snapshot', 'drain', 'release'].includes(request.method) && request.params?.captureId !== session?.captureId) {
          channel.send({ id: request.id, result: { ok: false, error: 'capture-mismatch' } }); return;
        }
        const handlers: Record<string, (p?: any) => unknown> = {
          inspect,
          prepare,
          start,
          status,
          stop: () => session?.collectorHandle || session?.pendingCollectorStop ? stopAsync() : stop(),
          snapshot: p => snapshot(p?.offset ?? 0, Number.isInteger(p?.limit) ? Math.min(Math.max(1, p.limit), 1024) : 64),
          drain: p => drain(p?.ackSeq ?? 0, Number.isInteger(p?.limit) ? Math.min(Math.max(1, p.limit), 1024) : 512),
          release,
          clock: readClock
        };
        const handler = handlers[request.method];
        const out = handler ? handler(request.params) : { ok: false, error: 'unknown-method' };
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          (out as Promise<unknown>).then(
            resolved => { try { channel.send({ id: request.id, result: resolved }); } catch { /* disconnect */ } },
            () => { try { channel.send({ id: request.id, result: { ok: false, error: 'control-error' } }); } catch { /* disconnect */ } }
          );
        } else {
          channel.send({ id: request.id, result: out });
        }
      } catch { try { channel.send({ id: request.id, result: { ok: false, error: 'control-error' } }); } catch { /* disconnect */ } }
    });
  }

  const instance = {
    validationErrors: validationErrors.slice(),
    inspect,
    prepare,
    start,
    stop,
    stopAsync,
    status,
    snapshot,
    drain,
    release,
    readClock,
    attachControl,
    connect(connectOptions: ConnectOptions): ConnectionHandle {
      return connectTransport(instance, connectOptions);
    }
  };
  return instance;
}
