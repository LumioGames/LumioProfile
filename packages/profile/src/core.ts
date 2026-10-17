import type { Options, CaptureConfig, Context, Marker, Snapshot, Quality, StatData, RecordData, ControlChannel, ControlRequest } from './types.ts';
export type * from './types.ts';

// The fixed reservation includes UTF-16 payload storage and numeric columns. It is
// a storage budget, not a claim about the JS VM's total heap / object overhead.
const SLOT_BYTES = 1024;
const TEXT_CHARS = 384;
const KEY_CHARS = 96;
const BASE_BYTES = 8192;
const KIND = ['begin', 'end', 'event', 'link'] as const;
const copyConfig = (c: Snapshot['config']) => ({ ...c, markerIds: c.markerIds?.slice() });

export function createProfiler(options: Options) {
  options = { ...options, build: { ...options.build }, environment: { ...options.environment } };
  const { host, clock, scheduler } = options;
  const policy = { maxBytes: 8 * 1024 * 1024, maxDurationMs: 60000, maxOpenSpans: 128, ...options.policy };
  const catalog = new Map<number, Marker>();
  let valid = host?.contract === 'lumio.observation/1' && !!options.sourceId && !!options.role;
  for (const m of options.markers.slice(0, 256)) {
    if (!Number.isInteger(m.id) || m.id < 1 || catalog.has(m.id) || m.name.length > 128 || (m.fields?.length ?? 0) > 4 || (m.buckets?.length ?? 0) > 32) valid = false;
    catalog.set(m.id, { ...m, fields: m.fields?.slice(), buckets: m.buckets?.slice() });
  }
  if (options.markers.length > 256 || policy.maxOpenSpans! > 4096 || policy.maxOpenSpans! < 1) valid = false;
  let serial = 0, active = false, generation = 0;
  let plan: { token: string; config: Snapshot['config'] } | undefined;
  let session: ReturnType<typeof makeSession> | undefined;
  let lastRequest: { requestId: string; captureId: string; result: any } | undefined;

  function makeSession(config: Snapshot['config'], captureId: string, requestId: string) {
    const statBytes = catalog.size * 512;
    const overhead = BASE_BYTES + policy.maxOpenSpans! * 32 + statBytes;
    const capacity = config.mode === 'trace' ? Math.max(1, Math.floor((config.maxBytes - overhead) / SLOT_BYTES)) : 0;
    const numbers = new Float64Array(capacity * 8);
    const texts = new Uint16Array(capacity * TEXT_CHARS);
    const spans = new Float64Array(policy.maxOpenSpans! * 3);
    const stats = new Map<number, { data: StatData; marker: Marker }>();
    if (config.mode === 'stats') for (const m of catalog.values()) {
      if (['counter', 'gauge', 'histogram'].includes(m.kind)) stats.set(m.id, { marker: m,
        data: { markerId: m.id, value: 0, count: 0, sum: 0, min: null, max: null, buckets: new Array((m.buckets?.length ?? 0) + 1).fill(0) } });
    }
    const quality: Quality = { dropped: 0, overwritten: 0, invalid: 0, filtered: 0, openSpans: 0, tail: 'unknown', reason: 'running', lastAttemptedSeq: 0, detail: 'complete' };
    const startedAt = clock.now();
    if (!Number.isFinite(startedAt)) throw new Error('clock-fault');
    return { config, captureId, requestId, streamId: `${options.sourceId}/${++serial}`, numbers, texts, spans, stats, quality,
      capacity, head: 0, length: 0, seq: 0, depth: 0, spanSerial: 0, startedAt, lastTime: startedAt, stoppedAt: startedAt,
      allocatedBytes: overhead + capacity * SLOT_BYTES, timer: undefined as unknown, selected: config.markerIds ? new Set(config.markerIds) : undefined };
  }
  function inspect() {
    return { protocol: 'lumio.control/1', sourceId: options.sourceId, role: options.role, build: options.build,
      supported: valid, mode: active ? session?.config.mode : 'off', environment: options.environment ?? {},
      capabilities: { stats: true, trace: true, nativeCpu: false, gpu: false, physicalPresent: false }, policy: { ...policy } };
  }
  function prepare(input: CaptureConfig) {
    if (!valid) return { ok: false as const, error: 'incompatible-host-or-catalog' };
    if (active || host.trace || host.stats) return { ok: false as const, error: 'busy' };
    if (options.build.mode === 'release' && !policy.allowRelease) return { ok: false as const, error: 'release-disabled' };
    if (!input || !['stats', 'trace'].includes(input.mode) || !Number.isFinite(input.durationMs) || input.durationMs <= 0 || input.durationMs > policy.maxDurationMs!) return { ok: false as const, error: 'invalid-duration-or-mode' };
    const maxBytes = input.maxBytes ?? Math.min(policy.maxBytes!, 8 * 1024 * 1024);
    if (!Number.isInteger(maxBytes) || maxBytes < BASE_BYTES + policy.maxOpenSpans! * 32 + catalog.size * 512 + SLOT_BYTES || maxBytes > policy.maxBytes!) return { ok: false as const, error: 'invalid-capacity' };
    if (input.overflowPolicy && !['drop-new-detail', 'overwrite-oldest-chunk'].includes(input.overflowPolicy)) return { ok: false as const, error: 'invalid-overflow-policy' };
    if (input.markerIds && (input.markerIds.length > 256 || input.markerIds.some(id => !catalog.has(id)))) return { ok: false as const, error: 'invalid-filter' };
    plan = { token: `${options.sourceId}/plan/${++serial}`, config: { mode: input.mode, durationMs: input.durationMs, maxBytes, overflowPolicy: input.overflowPolicy ?? 'drop-new-detail', markerIds: input.markerIds?.slice() } };
    return { ok: true as const, token: plan.token, config: copyConfig(plan.config) };
  }
  function stop(reason = 'requested') {
    if (!active || !session) return status();
    active = false;
    host.trace = undefined; host.stats = undefined;
    try { scheduler.clear(session.timer); } catch { /* A failed timer cleanup cannot affect the host. */ }
    session.quality.openSpans = session.depth;
    session.quality.tail = 'complete';
    session.quality.reason = reason;
    if (reason === 'clock-fault' || reason === 'writer-fault') session.quality.detail = 'partial';
    try { const t = clock.now(); if (Number.isFinite(t) && t >= session.lastTime) session.stoppedAt = t; } catch { /* preserve last known time */ }
    return status();
  }
  function status() {
    return { sourceId: options.sourceId, active, mode: active ? session?.config.mode : 'off', captureId: session?.captureId,
      streamId: session?.streamId, allocatedBytes: session?.allocatedBytes ?? 0, retainedRecords: session?.length ?? 0,
      stats: session?.config.mode === 'stats' ? [...session.stats.values()].map(({ data: v }) => ({ ...v, buckets: v.buckets.slice() })) : undefined,
      reason: session?.quality.reason ?? 'off', config: session ? copyConfig(session.config) : undefined, quality: session ? { ...session.quality } : undefined };
  }
  function release() {
    if (active) return { ok: false, error: 'stop-before-release' };
    if (session) { session.numbers = new Float64Array(0); session.texts = new Uint16Array(0); session.spans = new Float64Array(0); session.stats.clear(); }
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
    function live() { return active && generation === ownGeneration; }
    function drop(seq: number) {
      s.quality.dropped++; s.quality.detail = 'partial';
      s.quality.firstDroppedSeq ??= seq; s.quality.lastDroppedSeq = seq;
    }
    function putText(slot: number, offset: number, value: string | undefined, max: number) {
      if (value === undefined) return;
      if (typeof value !== 'string' || value.length >= max || value.includes('\0')) throw new Error('field-length-or-terminator');
      const base = slot * TEXT_CHARS + offset;
      for (let i = 0; i < value.length; i++) s.texts[base + i] = value.charCodeAt(i);
      s.texts[base + value.length] = 0;
    }
    // Capture accepts plain data only. No stringify, network or native export on this path.
    function record(kind: number, markerId: number, context?: Context, spanId = 0, parent = 0, correlation?: string, side?: 'out' | 'in') {
      if (!live()) return false;
      const m = catalog.get(markerId);
      if (!m || m.kind !== (kind < 2 ? 'span' : kind === 2 ? 'event' : 'link')) { s.quality.invalid++; s.quality.detail = 'partial'; return false; }
      if (s.selected && !s.selected.has(markerId)) { s.quality.filtered++; return false; }
      const seq = ++s.seq; s.quality.lastAttemptedSeq = seq;
      const reservedEnds = Math.min(16, Math.floor(s.capacity / 8));
      const limit = kind === 1 ? s.capacity : Math.max(1, s.capacity - reservedEnds);
      if (s.length >= limit) {
        if (s.config.overflowPolicy === 'drop-new-detail') { drop(seq); return false; }
        // v1 chunks contain at most 16 slots; discard a whole oldest chunk.
        const removed = Math.min(16, s.length);
        s.head = (s.head + removed) % s.capacity; s.length -= removed;
        s.quality.overwritten += removed; s.quality.detail = 'partial';
      }
      const time = clock.now();
      if (!Number.isFinite(time) || time < s.lastTime) { stop('clock-fault'); return false; }
      s.lastTime = time; s.stoppedAt = time;
      if (time - s.startedAt >= s.config.durationMs) { stop('deadline'); return false; }
      const slot = (s.head + s.length) % s.capacity, n = slot * 8;
      const textBase = slot * TEXT_CHARS;
      s.texts[textBase] = 0; s.texts[textBase + 96] = 0; s.texts[textBase + 192] = 0;
      for (let i = 0; i < 4; i++) s.texts[textBase + 288 + i * 24] = 0;
      try {
        putText(slot, 0, context?.operationKey, KEY_CHARS);
        putText(slot, 96, context?.entityKey, KEY_CHARS);
        putText(slot, 192, correlation, KEY_CHARS);
        // Optional fields are bounded primitive scalar annotations (four 23-char cells).
        for (let i = 0; i < (m.fields?.length ?? 0); i++) {
          const value = context?.fields?.[m.fields![i]];
          if (value !== undefined) {
            if (!['number', 'string', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('field-type');
            putText(slot, 288 + i * 24, `${typeof value === 'number' ? 'n' : typeof value === 'boolean' ? 'b' : 's'}${value}`, 24);
          }
        }
        if (context?.tick !== undefined && !Number.isSafeInteger(context.tick)) throw new Error('tick');
      } catch { s.quality.invalid++; drop(seq); return false; }
      s.numbers[n] = seq; s.numbers[n + 1] = time; s.numbers[n + 2] = kind;
      s.numbers[n + 3] = markerId; s.numbers[n + 4] = spanId; s.numbers[n + 5] = parent;
      s.numbers[n + 6] = context?.tick ?? NaN; s.numbers[n + 7] = side === 'out' ? 1 : side === 'in' ? 2 : 0;
      s.length++;
      return true;
    }
    if (s.config.mode === 'trace') host.trace = {
      begin(id, context) {
        if (!live()) return 0;
        try {
          if (s.depth >= policy.maxOpenSpans!) { s.quality.invalid++; s.quality.detail = 'partial'; return 0; }
          const token = ++s.spanSerial;
          const parent = s.depth ? s.spans[(s.depth - 1) * 3] : 0;
          if (!record(0, id, context, token, parent)) return 0;
          const n = s.depth++ * 3; s.spans[n] = token; s.spans[n + 1] = id; s.spans[n + 2] = parent;
          return token;
        } catch { stop('writer-fault'); return 0; }
      },
      end(token) {
        if (!live() || !token) return;
        try {
          const n = (s.depth - 1) * 3;
          if (s.depth === 0 || s.spans[n] !== token) { s.quality.invalid++; s.quality.detail = 'partial'; return; }
          record(1, s.spans[n + 1], undefined, token, s.spans[n + 2]); s.depth--;
        } catch { stop('writer-fault'); }
      },
      event(id, context) { if (live()) try { record(2, id, context); } catch { stop('writer-fault'); } },
      link(id, key, side, context) { if (live()) try { record(3, id, context, 0, 0, key, side); } catch { stop('writer-fault'); } }
    };
    if (s.config.mode === 'stats') {
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
    }
    try { s.timer = scheduler.set(() => { if (live()) stop('deadline'); }, s.config.durationMs); }
    catch { stop('scheduler-fault'); return { ok: false, error: 'scheduler-fault' }; }
    const result = { ok: true, captureId: s.captureId, streamId: s.streamId, startedAt: s.startedAt, config: copyConfig(s.config) };
    lastRequest = { requestId: input.requestId, captureId: input.captureId, result };
    return result;
  }
  function snapshot(offset = 0, limit = Number.MAX_SAFE_INTEGER): Snapshot & { window: { offset: number; total: number; next: number | null } } {
    if (active) throw new Error('stop-before-export');
    if (!session) throw new Error('no-capture');
    const s = session;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > s.length || !Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid-export-window');
    const until = Math.min(s.length, offset + limit);
    function textAt(slot: number, offset: number, max: number) {
      let str = ''; const base = slot * TEXT_CHARS + offset;
      for (let i = 0; i < max && s.texts[base + i]; i++) str += String.fromCharCode(s.texts[base + i]);
      return str || undefined;
    }
    const records: RecordData[] = [];
    for (let i = offset; i < until; i++) {
      const slot = (s.head + i) % s.capacity, n = slot * 8, markerId = s.numbers[n + 3];
      const context: Context = { operationKey: textAt(slot, 0, 96), entityKey: textAt(slot, 96, 96) };
      if (Number.isFinite(s.numbers[n + 6])) context.tick = s.numbers[n + 6];
      const m = catalog.get(markerId)!;
      const fields: Record<string, string | number | boolean> = {};
      for (let j = 0; j < (m.fields?.length ?? 0); j++) {
        const v = textAt(slot, 288 + j * 24, 24);
        if (v) fields[m.fields![j]] = v[0] === 'n' ? Number(v.slice(1)) : v[0] === 'b' ? v.slice(1) === 'true' : v.slice(1);
      }
      if (Object.keys(fields).length) context.fields = fields;
      records.push({ seq: s.numbers[n], time: s.numbers[n + 1], kind: KIND[s.numbers[n + 2]], markerId,
        spanId: s.numbers[n + 4] || undefined, parentSpanId: s.numbers[n + 5] || undefined,
        correlationKey: textAt(slot, 192, 96), side: s.numbers[n + 7] === 1 ? 'out' : s.numbers[n + 7] === 2 ? 'in' : undefined, context });
    }
    const { now: _, ...clockInfo } = clock;
    return { protocol: 'lumio.capture/1', captureId: s.captureId, streamId: s.streamId, sourceId: options.sourceId, role: options.role,
      build: { ...options.build }, clock: { ...clockInfo }, environment: { ...options.environment }, config: { ...s.config },
      startedAt: s.startedAt, stoppedAt: s.stoppedAt, allocatedBytes: s.allocatedBytes, markers: [...catalog.values()], records,
      stats: [...s.stats.values()].map(({ data: v }) => ({ ...v, buckets: v.buckets.slice() })), quality: { ...s.quality }, window: { offset, total: s.length, next: until < s.length ? until : null } };
  }
  function readClock() {
    if (!active) return { ok: false, error: 'off' };
    try { const time = clock.now(); return Number.isFinite(time) ? { ok: true, clockId: clock.id, clockEpoch: clock.epoch, time } : { ok: false, error: 'clock-fault' }; }
    catch { return { ok: false, error: 'clock-fault' }; }
  }
  function attachControl(channel: ControlChannel) {
    return channel.subscribe((request: ControlRequest) => {
      try {
        if (['stop', 'snapshot', 'release'].includes(request.method) && request.params?.captureId !== session?.captureId) {
          channel.send({ id: request.id, result: { ok: false, error: 'capture-mismatch' } }); return;
        }
        const handlers: Record<string, (p?: any) => unknown> = { inspect, prepare, start, status, stop: () => stop(), snapshot: p => snapshot(p?.offset ?? 0, 64), release, clock: readClock };
        const handler = handlers[request.method];
        channel.send({ id: request.id, result: handler ? handler(request.params) : { ok: false, error: 'unknown-method' } });
      } catch { try { channel.send({ id: request.id, result: { ok: false, error: 'control-error' } }); } catch { /* disconnect */ } }
    });
  }
  return { inspect, prepare, start, stop, status, snapshot, release, readClock, attachControl };
}
