import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { CaptureConfig, RecordData, Snapshot } from '../../profile/src/types.ts';
import type { CalibrationSample, CaptureInput, SourceLifecycle } from './analysis.ts';
import { exportCapture } from './bundle.ts';

interface Target {
  socket: WebSocket;
  info: any;
  connectionId: string;
  registeredAt: number;
  pending: Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>;
}
interface Plan {
  id: string;
  expires: number;
  targets: { sourceId: string; token: string; connectionId: string; registeredAt: number }[];
  config: CaptureConfig;
}
interface StreamDrainState {
  streamId?: string;
  ackSeq: number;
  records: RecordData[];
  inFlight?: Promise<void>;
}
interface Capture {
  id: string;
  requestId: string;
  plan: Plan;
  calibrations: CalibrationSample[];
  calibratingSources: Set<string>;
  streamedRecords: Map<string, StreamDrainState>;
  sourceLifecycle: SourceLifecycle;
  timer?: ReturnType<typeof setInterval>;
  drainTimer?: ReturnType<typeof setInterval>;
  raw?: CaptureInput;
  exported?: string;
  missingSourcesSnapshot?: string[];
  stoppedWallMs?: number;
  state: string;
  stopping?: Promise<any>;
  exporting?: Promise<string>;
}

export interface CalibrationOptions {
  intervalMs?: number;
  precisionMs?: number;
  maxDriftPpm?: number;
  validForMs?: number;
  maxExtrapolationMs?: number;
  maxSamples?: number;
}

export interface ServiceOptions {
  port?: number;
  token: string;
  outputRoot: string;
  allowedOrigins?: string[];
  requireOrigin?: boolean;
  maxActiveCaptures?: number;
  captureRetentionMs?: number;
  maxCaptureBytes?: number;
  maxRecordsPerSource?: number;
  continuousDrain?: boolean;
  drainIntervalMs?: number;
  rpcTimeoutMs?: number;
  calibration?: CalibrationOptions;
}

const TRANSIENT_RPC_ERRORS = /source-timeout|control-backlog|control-error|diagnostic-transport-busy/;

export async function createService(options: ServiceOptions) {
  if (!options.token || options.token.length < 16) throw new Error('token-must-have-at-least-16-characters');
  const targets = new Map<string, Target>();
  const plans = new Map<string, Plan>();
  const captures = new Map<string, Capture>();
  const outputRoot = resolve(options.outputRoot);
  await mkdir(outputRoot, { recursive: true });

  const maxActiveCaptures = options.maxActiveCaptures ?? 8;
  const captureRetentionMs = options.captureRetentionMs ?? 300_000;
  const maxCaptureBytes = options.maxCaptureBytes ?? 256 * 1024 * 1024;
  const maxRecordsPerSource = options.maxRecordsPerSource ?? 1_000_000;
  const continuousDrain = options.continuousDrain ?? true;
  const drainIntervalMs = options.drainIntervalMs ?? 250;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? 5000;
  const calCfg = {
    intervalMs: options.calibration?.intervalMs ?? 1000,
    precisionMs: options.calibration?.precisionMs ?? 1,
    maxDriftPpm: options.calibration?.maxDriftPpm ?? 1000,
    validForMs: options.calibration?.validForMs ?? 2500,
    maxExtrapolationMs: options.calibration?.maxExtrapolationMs ?? 60_000,
    maxSamples: options.calibration?.maxSamples ?? 2048
  };

  const validToken = (value: string) => {
    const a = Buffer.from(options.token), b = Buffer.from(value);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const originAllowed = (origin?: string) => {
    if (!origin) return !options.requireOrigin;
    return (options.allowedOrigins ?? []).includes(origin);
  };

  async function rpc(sourceId: string, method: string, params?: unknown, connectionId?: string, maxPending = 16): Promise<any> {
    const target = targets.get(sourceId);
    if (!target || target.socket.readyState !== WebSocket.OPEN) throw new Error(`source-unreachable:${sourceId}`);
    if (connectionId !== undefined && target.connectionId !== connectionId) throw new Error(`source-generation-mismatch:${sourceId}`);
    if (target.pending.size >= maxPending || target.socket.bufferedAmount > 4 * 1024 * 1024) throw new Error('control-backlog');
    const id = randomUUID();
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => { target.pending.delete(id); rejectPromise(new Error('source-timeout')); }, rpcTimeoutMs);
      target.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      target.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function rpcWithRetry(sourceId: string, method: string, params?: unknown, connectionId?: string, attempts = 3): Promise<any> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await rpc(sourceId, method, params, connectionId);
        if (res && typeof res === 'object' && res.ok === false && res.error === 'control-error' && attempt + 1 < attempts) {
          lastError = new Error('control-error');
        } else {
          return res;
        }
      } catch (err) {
        lastError = err;
        const msg = (err as Error)?.message ?? '';
        if (!TRANSIENT_RPC_ERRORS.test(msg) || attempt + 1 >= attempts) throw err;
      }
      await new Promise(r => setTimeout(r, 40 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error('rpc-retry-exhausted');
  }

  const instance = randomUUID();
  const referenceId = 'tool-monotonic/' + instance;

  async function sample(c: Capture, allowStopping = false) {
    if ((c.state !== 'running' && (!allowStopping || c.state !== 'stopping')) || c.calibrations.length >= calCfg.maxSamples) return;
    await Promise.all(c.plan.targets.map(async ({ sourceId, connectionId }) => {
      if (c.calibratingSources.has(sourceId)) return;
      c.calibratingSources.add(sourceId);
      const a1 = performance.now();
      try {
        const result = await rpc(sourceId, 'clock', undefined, connectionId);
        const a4 = performance.now();
        if (result?.ok && (c.state === 'running' || (allowStopping && c.state === 'stopping')) && c.calibrations.length < calCfg.maxSamples) {
          const sourcePrecision = typeof result.precisionMs === 'number' && Number.isFinite(result.precisionMs) && result.precisionMs >= 0
            ? Math.max(calCfg.precisionMs, result.precisionMs)
            : calCfg.precisionMs;
          c.calibrations.push({
            id: randomUUID(),
            sourceId,
            clockId: result.clockId,
            clockEpoch: result.clockEpoch,
            referenceId,
            a1,
            b2: result.time,
            b3: result.time,
            a4,
            precisionMs: sourcePrecision,
            maxDriftPpm: calCfg.maxDriftPpm,
            validForMs: calCfg.validForMs,
            maxExtrapolationMs: calCfg.maxExtrapolationMs
          });
        }
      } catch {
        /* A missing calibration sample does not abort local observations. */
      } finally {
        c.calibratingSources.delete(sourceId);
      }
    }));
  }

  function drainSourceOnce(c: Capture, sourceId: string, connectionId: string): Promise<void> {
    let state = c.streamedRecords.get(sourceId);
    if (!state) { state = { ackSeq: 0, records: [] }; c.streamedRecords.set(sourceId, state); }
    if (state.inFlight) return state.inFlight;
    const st = state;
    const job = (async () => {
      try {
        while (c.state === 'running') {
          const res = await rpc(sourceId, 'drain', { captureId: c.id, ackSeq: st.ackSeq, limit: 512 }, connectionId);
          if (!res?.ok || res.captureId !== c.id || !Array.isArray(res.records)) break;
          if (st.streamId && st.streamId !== res.streamId) break;
          st.streamId = res.streamId;
          let newlyAcked = 0;
          for (let i = 0; i < res.records.length; i++) {
            const rec = res.records[i] as RecordData;
            if (rec.seq > st.ackSeq) {
              st.records.push(rec);
              st.ackSeq = rec.seq;
              newlyAcked++;
            }
          }
          // Loop once more after receiving records so ackSeq immediately frees slots on the source,
          // then stop as soon as no new records remain.
          if (st.records.length > maxRecordsPerSource || newlyAcked === 0) break;
        }
      } catch {
        /* Transient drain errors leave records safely buffered on the source for stop/retry. */
      } finally {
        st.inFlight = undefined;
      }
    })();
    st.inFlight = job;
    return job;
  }

  function pruneCaptures() {
    const now = performance.now();
    for (const [id, cap] of captures) {
      if (['running', 'starting', 'stopping'].includes(cap.state) || cap.exporting) continue;
      if (!cap.exported && cap.stoppedWallMs !== undefined && now - cap.stoppedWallMs > captureRetentionMs) {
        cap.raw = undefined;
        cap.streamedRecords.clear();
        captures.delete(id);
      }
    }
    if (captures.size > 256) {
      for (const [id, cap] of captures) {
        if (captures.size <= 256) break;
        if (cap.exported && !cap.exporting) captures.delete(id);
      }
    }
  }

  function countUnexportedCaptures() {
    let n = 0;
    for (const cap of captures.values()) {
      if (!cap.exported && cap.state !== 'released' && cap.state !== 'partial-start') n++;
    }
    return n;
  }

  function lifecycleSnapshot(c: Capture): SourceLifecycle {
    return {
      ...c.sourceLifecycle,
      selectedSources: c.sourceLifecycle.selectedSources.map(source => ({ ...source })),
      events: c.sourceLifecycle.events.map(event => ({ ...event }))
    };
  }

  function lifecycleEvent(kind: 'registered' | 'disconnected', sourceId: string, target: Target) {
    const atMs = performance.now();
    for (const c of captures.values()) {
      if (!['starting', 'running', 'stopping'].includes(c.state) || c.raw || c.exported) continue;
      const lifecycle = c.sourceLifecycle;
      if (lifecycle.events.length >= 128) { lifecycle.droppedEvents++; continue; }
      lifecycle.events.push({
        kind,
        sourceId,
        connectionId: target.connectionId,
        atMs,
        selected: c.plan.targets.some(source => source.connectionId === target.connectionId)
      });
    }
  }

  async function pullSingleSource(
    c: Capture,
    sourceId: string,
    connectionId: string,
    exportDeadline: number
  ): Promise<Snapshot> {
    const drainState = c.streamedRecords.get(sourceId);
    if (drainState?.inFlight) await drainState.inFlight;
    if (performance.now() >= exportDeadline) throw new Error('export-deadline');
    const s = await rpcWithRetry(sourceId, 'snapshot', { captureId: c.id, offset: 0, limit: 512 }, connectionId, 3);
    if (!s || s.protocol !== 'lumio.capture/1' || s.captureId !== c.id) throw new Error('wrong-capture');
    let next = s.window?.next;
    const pageRecords: RecordData[] = Array.isArray(s.records) ? s.records.slice() : [];
    while (next !== null && next !== undefined) {
      if (performance.now() >= exportDeadline) throw new Error('export-deadline');
      const part = await rpcWithRetry(sourceId, 'snapshot', { captureId: c.id, offset: next, limit: 512 }, connectionId, 3);
      if (!part || part.captureId !== c.id || part.streamId !== s.streamId || part.window?.offset !== next || part.records.length > 512 || part.window?.total !== s.window.total) {
        throw new Error('invalid-export-page');
      }
      for (let i = 0; i < part.records.length; i++) pageRecords.push(part.records[i]);
      const after = part.window.next;
      if (after !== null && after <= next) throw new Error('invalid-export-progress');
      next = after;
      if ((drainState?.records.length ?? 0) + pageRecords.length > maxRecordsPerSource) throw new Error('export-record-budget');
    }
    delete s.window;
    if (drainState && drainState.records.length > 0 && (!drainState.streamId || drainState.streamId === s.streamId)) {
      const merged = drainState.records.slice();
      let lastSeq = merged[merged.length - 1].seq;
      for (let i = 0; i < pageRecords.length; i++) {
        if (pageRecords[i].seq > lastSeq) {
          merged.push(pageRecords[i]);
          lastSeq = pageRecords[i].seq;
        }
      }
      s.records = merged;
    } else {
      s.records = pageRecords;
    }
    if (s.records.length > maxRecordsPerSource) throw new Error('export-record-budget');
    drainState && (drainState.records = []);
    await rpc(sourceId, 'release', { captureId: c.id }, connectionId).catch(() => {});
    return s as Snapshot;
  }

  async function call(method: string, params: any = {}): Promise<any> {
    if (method === 'targets') {
      return [...targets.values()].map(t => ({
        ...t.info,
        controlConnection: { id: t.connectionId, registeredAt: t.registeredAt, referenceId }
      }));
    }
    if (method === 'inspect') return rpc(params.sourceId, 'inspect');
    if (method === 'prepare') {
      if (!Array.isArray(params.targets) || params.targets.length < 1 || params.targets.length > 32 || new Set(params.targets).size !== params.targets.length) throw new Error('invalid-targets');
      for (const [id, p] of plans) if (p.expires < performance.now()) plans.delete(id);
      if (plans.size >= 16) throw new Error('plan-budget');
      const prepared: Plan['targets'] = [];
      for (const sourceId of params.targets) {
        const target = targets.get(sourceId);
        if (!target) throw new Error(`source-unreachable:${sourceId}`);
        const result = await rpc(sourceId, 'prepare', params.config, target.connectionId);
        if (!result.ok) {
          const detail = Array.isArray(result.reasons) && result.reasons.length ? ` (${result.reasons.join('; ')})` : '';
          throw new Error(`prepare:${sourceId}:${result.error}${detail}`);
        }
        prepared.push({ sourceId, token: result.token, connectionId: target.connectionId, registeredAt: target.registeredAt });
      }
      const p: Plan = { id: randomUUID(), expires: performance.now() + 30000, targets: prepared, config: params.config };
      plans.set(p.id, p);
      return { planId: p.id, targets: prepared.map(t => t.sourceId), config: p.config, expiresInMs: 30000 };
    }
    if (method === 'start') {
      const prior = [...captures.values()].find(c => c.requestId === params.requestId);
      if (prior) {
        if (prior.plan.id !== params.planId) throw new Error('request-conflict');
        return { captureId: prior.id, state: prior.state };
      }
      const plan = plans.get(params.planId);
      if (!plan || plan.expires < performance.now() || typeof params.requestId !== 'string' || !params.requestId || params.requestId.length > 128) {
        throw new Error('invalid-plan-or-request');
      }
      pruneCaptures();
      if (countUnexportedCaptures() >= maxActiveCaptures) {
        throw new Error('capture-budget-export-or-release-active-captures');
      }
      const c: Capture = {
        id: randomUUID(),
        requestId: params.requestId,
        plan,
        calibrations: [],
        calibratingSources: new Set(),
        streamedRecords: new Map(),
        state: 'starting',
        sourceLifecycle: {
          referenceId,
          captureStartedAt: performance.now(),
          selectedSources: plan.targets.map(({ sourceId, connectionId, registeredAt }) => ({ sourceId, connectionId, registeredAt })),
          events: [],
          droppedEvents: 0
        }
      };
      captures.set(c.id, c);
      const started: Plan['targets'] = [];
      try {
        for (const t of plan.targets) {
          const r = await rpc(t.sourceId, 'start', { token: t.token, requestId: params.requestId, captureId: c.id }, t.connectionId);
          if (!r.ok) throw new Error(`start:${r.error}`);
          started.push(t);
        }
        c.state = 'running';
        await sample(c);
        c.timer = setInterval(() => { void sample(c); }, calCfg.intervalMs);
        c.timer.unref();
        if (continuousDrain && plan.config.mode !== 'stats' && plan.config.overflowPolicy !== 'overwrite-oldest-chunk') {
          c.drainTimer = setInterval(() => {
            if (c.state !== 'running') return;
            for (const t of c.plan.targets) void drainSourceOnce(c, t.sourceId, t.connectionId);
          }, drainIntervalMs);
          c.drainTimer.unref();
        }
        // Host deadlines are authoritative. This timer also bounds coordinator work.
        setTimeout(() => {
          if (c.state === 'running') void call('stop', { captureId: c.id }).catch(() => {});
        }, Math.min(plan.config.durationMs, 300_000) + 50).unref();
        return { captureId: c.id, state: c.state };
      } catch (error) {
        c.state = 'partial-start';
        c.stoppedWallMs = performance.now();
        await Promise.allSettled(started.map(t => rpc(t.sourceId, 'stop', { captureId: c.id }, t.connectionId)));
        throw error;
      }
    }

    const c = captures.get(params.captureId);
    if (!c) throw new Error('unknown-capture');

    if (method === 'status') {
      return {
        captureId: c.id,
        state: c.state,
        exported: c.exported,
        calibrationSamples: c.calibrations.length,
        sourceLifecycle: lifecycleSnapshot(c),
        sources: await Promise.all(c.plan.targets.map(async t => {
          try { return await rpc(t.sourceId, 'status', undefined, t.connectionId); }
          catch (error) { return { sourceId: t.sourceId, state: 'unreachable', reason: (error as Error).message }; }
        }))
      };
    }

    if (method === 'stop') {
      if (c.stopping) return c.stopping;
      if (c.exported) return { captureId: c.id, state: c.state, missingSources: c.missingSourcesSnapshot ?? [] };
      if (c.raw) return { captureId: c.id, state: c.state, missingSources: c.raw.missingSources ?? [] };
      return c.stopping = (async () => {
        c.state = 'stopping';
        clearInterval(c.timer);
        if (c.drainTimer) clearInterval(c.drainTimer);

        // Phase 1 (D1): Concurrently stop ALL sources first so later sources never keep recording while earlier sources paginate.
        const stopOutcomes = await Promise.allSettled(
          c.plan.targets.map(({ sourceId, connectionId }) =>
            rpcWithRetry(sourceId, 'stop', { captureId: c.id }, connectionId, 3)
          )
        );

        // Phase 2 (D2): Post-stop tail calibration across all stopped sources before releasing their sessions.
        await sample(c, true);

        // Phase 3 (B9): Export pages sequentially with per-page retries.
        const sources: Snapshot[] = [];
        const missingSources: string[] = [];
        let bytes = 0;
        const exportDeadline = performance.now() + 30000;
        for (let i = 0; i < c.plan.targets.length; i++) {
          const { sourceId, connectionId } = c.plan.targets[i];
          if (stopOutcomes[i].status === 'rejected') {
            missingSources.push(sourceId);
            continue;
          }
          try {
            const s = await pullSingleSource(c, sourceId, connectionId, exportDeadline);
            bytes += Buffer.byteLength(JSON.stringify(s));
            if (bytes > maxCaptureBytes) throw new Error('tool-memory-budget');
            sources.push(s);
          } catch {
            missingSources.push(sourceId);
          }
        }
        c.sourceLifecycle.observationStoppedAt = performance.now();
        c.stoppedWallMs = c.sourceLifecycle.observationStoppedAt;
        c.raw = {
          sources,
          calibrations: c.calibrations,
          missingSources,
          sourceLifecycle: lifecycleSnapshot(c),
          maxExtrapolationMs: calCfg.maxExtrapolationMs
        };
        c.missingSourcesSnapshot = missingSources.slice();
        c.state = missingSources.length ? 'partial' : 'stopped';
        c.stopping = undefined;
        return { captureId: c.id, state: c.state, missingSources };
      })();
    }

    if (method === 'pull') {
      if (c.exported) throw new Error('capture-already-exported');
      if (!c.raw) await call('stop', { captureId: c.id });
      const missing = c.raw!.missingSources ?? [];
      const wanted = params.sourceId ? missing.filter(id => id === params.sourceId) : missing.slice();
      const recovered: string[] = [];
      let bytes = c.raw!.sources.reduce((sum, s) => sum + Buffer.byteLength(JSON.stringify(s)), 0);
      const exportDeadline = performance.now() + 30000;
      for (const sourceId of wanted) {
        const entry = c.plan.targets.find(t => t.sourceId === sourceId);
        if (!entry) continue;
        try {
          await rpcWithRetry(sourceId, 'stop', { captureId: c.id }, entry.connectionId, 3);
          const s = await pullSingleSource(c, sourceId, entry.connectionId, exportDeadline);
          bytes += Buffer.byteLength(JSON.stringify(s));
          if (bytes > maxCaptureBytes) throw new Error('tool-memory-budget');
          c.raw!.sources.push(s);
          recovered.push(sourceId);
        } catch {
          /* keep in missingSources */
        }
      }
      if (recovered.length > 0) {
        c.raw!.missingSources = (c.raw!.missingSources ?? []).filter(id => !recovered.includes(id));
        c.missingSourcesSnapshot = c.raw!.missingSources.slice();
        if (c.raw!.missingSources.length === 0) c.state = 'stopped';
      }
      return { captureId: c.id, state: c.state, recovered, missingSources: c.raw!.missingSources ?? [] };
    }

    if (method === 'export') {
      if (!c.raw && !c.exported) await call('stop', { captureId: c.id });
      if (c.exported) return { captureId: c.id, path: c.exported, state: c.state };
      if (!c.exporting) {
        c.exporting = (async () => {
          const path = join(outputRoot, c.id);
          await exportCapture(c.raw!, path);
          c.exported = path;
          c.missingSourcesSnapshot = (c.raw!.missingSources ?? []).slice();
          // Release heavy raw payload from service RAM once persisted to immutable bundle on disk (B2).
          c.raw = undefined;
          c.streamedRecords.clear();
          c.calibrations = [];
          return path;
        })();
      }
      try {
        await c.exporting;
      } finally {
        c.exporting = undefined;
      }
      return { captureId: c.id, path: c.exported, state: c.state };
    }

    if (method === 'release') {
      if (['starting', 'running', 'stopping'].includes(c.state) || c.exporting) throw new Error('capture-busy');
      c.raw = undefined;
      c.streamedRecords.clear();
      c.calibrations = [];
      if (!c.exported) {
        c.state = 'released';
        captures.delete(c.id);
      }
      return { ok: true, captureId: c.id };
    }

    throw new Error('unknown-method');
  }

  const server = createServer(async (req, res) => {
    if (!originAllowed(req.headers.origin)) { res.writeHead(403); res.end(); return; }
    if (!validToken((req.headers.authorization ?? '').replace(/^Bearer /, ''))) { res.writeHead(401); res.end(); return; }
    if (req.method !== 'POST' || !/^\/api\/[a-z]+$/.test(req.url ?? '')) { res.writeHead(404); res.end(); return; }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) throw new Error('request-budget');
      }
      const result = await call(req.url!.slice(5), body ? JSON.parse(body) : {});
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  server.requestTimeout = 30000;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 32 * 1024 * 1024,
    perMessageDeflate: false,
    handleProtocols(protocols) {
      for (const p of protocols) if (p === 'lumio-control-v1') return p;
      return false;
    }
  });

  function extractUpgradeToken(req: any, url: URL): { provided: boolean; valid: boolean } {
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    if (authHeader.startsWith('Bearer ')) {
      return { provided: true, valid: validToken(authHeader.slice(7).trim()) };
    }
    const protoHeader = typeof req.headers['sec-websocket-protocol'] === 'string' ? req.headers['sec-websocket-protocol'] : '';
    if (protoHeader) {
      for (const item of protoHeader.split(',').map((s: string) => s.trim())) {
        if (item.startsWith('lumio-token.')) {
          return { provided: true, valid: validToken(item.slice('lumio-token.'.length)) };
        }
      }
    }
    if (url.searchParams.has('token')) {
      return { provided: true, valid: validToken(url.searchParams.get('token') ?? '') };
    }
    return { provided: false, valid: false };
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/target' || !originAllowed(req.headers.origin) || wss.clients.size >= 32) {
      socket.destroy();
      return;
    }
    const tokenCheck = extractUpgradeToken(req, url);
    if (tokenCheck.provided && !tokenCheck.valid) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      (ws as any).__lumioPreAuth = tokenCheck.valid;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', socket => {
    let authenticated = Boolean((socket as any).__lumioPreAuth);
    let ownId: string | undefined;
    const helloTimer = setTimeout(() => { if (!ownId) socket.close(1008, 'hello-timeout'); }, 5000);
    socket.on('message', data => {
      try {
        const r = JSON.parse(data.toString());
        if (r.hello) {
          if (!authenticated) {
            const msgToken = typeof r.auth === 'string' ? r.auth : typeof r.token === 'string' ? r.token : '';
            if (!validToken(msgToken)) { socket.close(1008, 'unauthorized'); return; }
            authenticated = true;
          }
          if (ownId || typeof r.hello.sourceId !== 'string' || !r.hello.sourceId || r.hello.sourceId.length > 128) {
            socket.close();
            return;
          }
          // If an earlier socket with the same sourceId is still lingering (e.g. HMR reload), evict it cleanly.
          const existing = targets.get(r.hello.sourceId);
          if (existing) {
            lifecycleEvent('disconnected', r.hello.sourceId, existing);
            for (const p of existing.pending.values()) {
              clearTimeout(p.timer);
              p.reject(new Error('source-disconnected'));
            }
            targets.delete(r.hello.sourceId);
            try { existing.socket.close(); } catch {}
          }
          ownId = r.hello.sourceId;
          clearTimeout(helloTimer);
          const target: Target = { socket, info: r.hello, connectionId: randomUUID(), registeredAt: performance.now(), pending: new Map() };
          targets.set(ownId!, target);
          lifecycleEvent('registered', ownId!, target);
          try { socket.send(JSON.stringify({ helloAck: { ok: true, sourceId: ownId, connectionId: target.connectionId } })); } catch {}
          return;
        }
        if (!authenticated || !ownId) { socket.close(1008, 'unauthorized'); return; }
        const t = targets.get(ownId);
        if (t?.socket !== socket) return;
        const pending = t.pending.get(r.id);
        if (pending) {
          clearTimeout(pending.timer);
          t.pending.delete(r.id);
          pending.resolve(r.result);
        }
      } catch { socket.close(); }
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (!ownId) return;
      const t = targets.get(ownId);
      if (t?.socket !== socket) return;
      lifecycleEvent('disconnected', ownId, t);
      for (const p of t.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('source-disconnected'));
      }
      targets.delete(ownId);
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(options.port ?? 9466, '127.0.0.1', resolvePromise);
  });
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/target`,
    call,
    async close() {
      for (const c of captures.values()) {
        clearInterval(c.timer);
        if (c.drainTimer) clearInterval(c.drainTimer);
      }
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      await new Promise<void>(r => server.close(() => r()));
    }
  };
}
