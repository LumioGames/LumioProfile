import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { CaptureConfig, Snapshot } from '../../profile/src/types.ts';
import type { CalibrationSample, CaptureInput, SourceLifecycle } from './analysis.ts';
import { exportCapture } from './bundle.ts';

interface Target { socket: WebSocket; info: any; connectionId: string; registeredAt: number; pending: Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }> }
interface Plan { id: string; expires: number; targets: { sourceId: string; token: string; connectionId: string; registeredAt: number }[]; config: CaptureConfig }
interface Capture { id: string; requestId: string; plan: Plan; calibrations: CalibrationSample[]; sourceLifecycle: SourceLifecycle; timer?: ReturnType<typeof setInterval>; raw?: CaptureInput; exported?: string; state: string; stopping?: Promise<any>; exporting?: Promise<string> }
export async function createService(options: { port?: number; token: string; outputRoot: string; allowedOrigins?: string[] }) {
  if (!options.token || options.token.length < 16) throw new Error('token-must-have-at-least-16-characters');
  const targets = new Map<string, Target>(), plans = new Map<string, Plan>(), captures = new Map<string, Capture>();
  const outputRoot = resolve(options.outputRoot); await mkdir(outputRoot, { recursive: true });
  const validToken = (value: string) => { const a = Buffer.from(options.token), b = Buffer.from(value); return a.length === b.length && timingSafeEqual(a, b); };
  const originAllowed = (origin?: string) => !origin || (options.allowedOrigins ?? []).includes(origin);
  async function rpc(sourceId: string, method: string, params?: unknown, connectionId?: string): Promise<any> {
    const target = targets.get(sourceId);
    if (!target || target.socket.readyState !== WebSocket.OPEN) throw new Error(`source-unreachable:${sourceId}`);
    if (connectionId !== undefined && target.connectionId !== connectionId) throw new Error(`source-generation-mismatch:${sourceId}`);
    if (target.pending.size >= 8 || target.socket.bufferedAmount > 65536) throw new Error('control-backlog');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { target.pending.delete(id); reject(new Error('source-timeout')); }, 5000);
      target.pending.set(id, { resolve, reject, timer });
      target.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function sample(c: Capture) {
    if (c.state !== 'running' || c.calibrations.length >= 512) return;
    await Promise.all(c.plan.targets.map(async ({ sourceId, connectionId }) => {
      const a1 = performance.now();
      try {
        const result = await rpc(sourceId, 'clock', undefined, connectionId); const a4 = performance.now();
        if (result.ok && c.state === 'running' && c.calibrations.length < 512) c.calibrations.push({ id: randomUUID(), sourceId, clockId: result.clockId, clockEpoch: result.clockEpoch,
          referenceId: 'tool-monotonic/' + instance, a1, b2: result.time, b3: result.time, a4,
          precisionMs: 1, maxDriftPpm: 1000, validForMs: 1500 });
      } catch { /* A missing calibration invalidates timing, not local observations. */ }
    }));
  }
  const instance = randomUUID();
  const referenceId = 'tool-monotonic/' + instance;
  function lifecycleSnapshot(c: Capture): SourceLifecycle {
    return { ...c.sourceLifecycle, selectedSources: c.sourceLifecycle.selectedSources.map(source => ({ ...source })), events: c.sourceLifecycle.events.map(event => ({ ...event })) };
  }
  function lifecycleEvent(kind: 'registered' | 'disconnected', sourceId: string, target: Target) {
    const atMs = performance.now();
    for (const c of captures.values()) {
      if (!['starting', 'running', 'stopping'].includes(c.state) || c.raw) continue;
      const lifecycle = c.sourceLifecycle;
      if (lifecycle.events.length >= 128) { lifecycle.droppedEvents++; continue; }
      lifecycle.events.push({ kind, sourceId, connectionId: target.connectionId, atMs,
        selected: c.plan.targets.some(source => source.connectionId === target.connectionId) });
    }
  }
  async function call(method: string, params: any = {}): Promise<any> {
    if (method === 'targets') return [...targets.values()].map(t => ({ ...t.info, controlConnection: { id: t.connectionId, registeredAt: t.registeredAt, referenceId } }));
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
        if (!result.ok) throw new Error(`prepare:${sourceId}:${result.error}`);
        prepared.push({ sourceId, token: result.token, connectionId: target.connectionId, registeredAt: target.registeredAt });
      }
      const p: Plan = { id: randomUUID(), expires: performance.now() + 30000, targets: prepared, config: params.config };
      plans.set(p.id, p); return { planId: p.id, targets: prepared.map(t => t.sourceId), config: p.config, expiresInMs: 30000 };
    }
    if (method === 'start') {
      const prior = [...captures.values()].find(c => c.requestId === params.requestId);
      if (prior) { if (prior.plan.id !== params.planId) throw new Error('request-conflict'); return { captureId: prior.id, state: prior.state }; }
      const plan = plans.get(params.planId);
      if (!plan || plan.expires < performance.now() || typeof params.requestId !== 'string' || !params.requestId || params.requestId.length > 128) throw new Error('invalid-plan-or-request');
      if (captures.size >= 4) throw new Error('capture-budget-restart-service-after-export');
      const c: Capture = { id: randomUUID(), requestId: params.requestId, plan, calibrations: [], state: 'starting',
        sourceLifecycle: { referenceId, captureStartedAt: performance.now(),
          selectedSources: plan.targets.map(({ sourceId, connectionId, registeredAt }) => ({ sourceId, connectionId, registeredAt })), events: [], droppedEvents: 0 } };
      captures.set(c.id, c);
      const started: Plan['targets'] = [];
      try {
        for (const t of plan.targets) {
          const r = await rpc(t.sourceId, 'start', { token: t.token, requestId: params.requestId, captureId: c.id }, t.connectionId);
          if (!r.ok) throw new Error(`start:${r.error}`); started.push(t);
        }
        c.state = 'running'; await sample(c);
        c.timer = setInterval(() => { void sample(c); }, 1000); c.timer.unref();
        // Host deadlines are authoritative. This timer also bounds coordinator work.
        setTimeout(() => { if (c.state === 'running') void call('stop', { captureId: c.id }).catch(() => {}); }, Math.min(plan.config.durationMs, 60000) + 50).unref();
        return { captureId: c.id, state: c.state };
      } catch (error) {
        c.state = 'partial-start';
        await Promise.allSettled(started.map(t => rpc(t.sourceId, 'stop', { captureId: c.id }, t.connectionId)));
        throw error;
      }
    }
    const c = captures.get(params.captureId);
    if (!c) throw new Error('unknown-capture');
    if (method === 'status') return { captureId: c.id, state: c.state, calibrationSamples: c.calibrations.length,
      sourceLifecycle: lifecycleSnapshot(c),
      sources: await Promise.all(c.plan.targets.map(async t => { try { return await rpc(t.sourceId, 'status', undefined, t.connectionId); } catch (error) { return { sourceId: t.sourceId, state: 'unreachable', reason: (error as Error).message }; } })) };
    if (method === 'stop') {
      if (c.stopping) return c.stopping;
      if (c.raw) return { captureId: c.id, state: c.state, missingSources: c.raw.missingSources };
      return c.stopping = (async () => {
      await sample(c); c.state = 'stopping'; clearInterval(c.timer);
      const sources: Snapshot[] = [], missingSources: string[] = []; let bytes = 0;
      const exportDeadline = performance.now() + 10000;
      for (const { sourceId, connectionId } of c.plan.targets) {
        try {
          if (performance.now() >= exportDeadline) throw new Error('export-deadline');
          await rpc(sourceId, 'stop', { captureId: c.id }, connectionId);
          const s = await rpc(sourceId, 'snapshot', { captureId: c.id, offset: 0 }, connectionId);
          if (s.protocol !== 'lumio.capture/1' || s.captureId !== c.id) throw new Error('wrong-capture');
          let next = s.window?.next;
          while (next !== null && next !== undefined) {
            if (performance.now() >= exportDeadline) throw new Error('export-deadline');
            const part = await rpc(sourceId, 'snapshot', { captureId: c.id, offset: next }, connectionId);
            if (part.captureId !== c.id || part.streamId !== s.streamId || part.window?.offset !== next || part.records.length > 64 || part.window?.total !== s.window.total) throw new Error('invalid-export-page');
            s.records.push(...part.records);
            const after = part.window.next;
            if (after !== null && after <= next) throw new Error('invalid-export-progress');
            next = after;
            if (s.records.length > 131072) throw new Error('export-record-budget');
          }
          delete s.window;
          bytes += Buffer.byteLength(JSON.stringify(s)); if (bytes > 32 * 1024 * 1024) throw new Error('tool-memory-budget');
          sources.push(s);
          await rpc(sourceId, 'release', { captureId: c.id }, connectionId).catch(() => {});
        } catch { missingSources.push(sourceId); }
      }
      c.sourceLifecycle.observationStoppedAt = performance.now();
      c.raw = { sources, calibrations: c.calibrations, missingSources, sourceLifecycle: lifecycleSnapshot(c) }; c.state = missingSources.length ? 'partial' : 'stopped';
      return { captureId: c.id, state: c.state, missingSources };
      })();
    }
    if (method === 'export') {
      if (!c.raw) await call('stop', { captureId: c.id });
      if (!c.exporting) c.exporting = (async () => { const path = join(outputRoot, c.id); await exportCapture(c.raw!, path); c.exported = path; return path; })();
      await c.exporting;
      return { captureId: c.id, path: c.exported, state: c.state };
    }
    throw new Error('unknown-method');
  }
  const server = createServer(async (req, res) => {
    if (!originAllowed(req.headers.origin)) { res.writeHead(403); res.end(); return; }
    if (!validToken((req.headers.authorization ?? '').replace(/^Bearer /, ''))) { res.writeHead(401); res.end(); return; }
    if (req.method !== 'POST' || !/^\/api\/[a-z]+$/.test(req.url ?? '')) { res.writeHead(404); res.end(); return; }
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) throw new Error('request-budget'); }
      const result = await call(req.url!.slice(5), body ? JSON.parse(body) : {});
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: (error as Error).message })); }
  });
  server.requestTimeout = 10000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/target' || !originAllowed(req.headers.origin) || !validToken(url.searchParams.get('token') ?? '') || wss.clients.size >= 32) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', socket => {
    let ownId: string | undefined;
    const helloTimer = setTimeout(() => { if (!ownId) socket.close(); }, 5000);
    socket.on('message', data => {
      try {
        const r = JSON.parse(data.toString());
        if (r.hello) {
          if (ownId || typeof r.hello.sourceId !== 'string' || r.hello.sourceId.length > 128 || targets.has(r.hello.sourceId)) { socket.close(); return; }
          ownId = r.hello.sourceId; clearTimeout(helloTimer);
          const target: Target = { socket, info: r.hello, connectionId: randomUUID(), registeredAt: performance.now(), pending: new Map() };
          targets.set(ownId!, target); lifecycleEvent('registered', ownId!, target); return;
        }
        if (!ownId) return;
        const t = targets.get(ownId);
        if (t?.socket !== socket) return;
        const pending = t.pending.get(r.id);
        if (pending) { clearTimeout(pending.timer); t!.pending.delete(r.id); pending.resolve(r.result); }
      } catch { socket.close(); }
    });
    socket.on('close', () => {
      clearTimeout(helloTimer); if (!ownId) return;
      const t = targets.get(ownId); if (t?.socket !== socket) return;
      lifecycleEvent('disconnected', ownId, t);
      for (const p of t.pending.values()) { clearTimeout(p.timer); p.reject(new Error('source-disconnected')); }
      targets.delete(ownId);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 9466, '127.0.0.1', resolve); });
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, wsUrl: `ws://127.0.0.1:${address.port}/target`, call,
    async close() { for (const c of captures.values()) clearInterval(c.timer); for (const socket of wss.clients) socket.terminate(); wss.close(); await new Promise<void>(r => server.close(() => r())); } };
}
