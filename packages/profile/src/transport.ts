import type { ControlChannel, ControlRequest, ConnectOptions, ConnectionHandle } from './types.ts';

/** Adapts an already opened, host-owned socket. Does not create connections. */
export function websocketChannel(socket: {
  readyState: number; bufferedAmount: number; send(data: string): void;
  addEventListener(type: string, callback: any): void; removeEventListener(type: string, callback: any): void;
}, maxMessageBytes = 32 * 1024 * 1024, maxBufferedBytes = 4 * 1024 * 1024): ControlChannel {
  return {
    subscribe(handler) {
      const listener = (event: { data: unknown }) => {
        const raw = typeof event.data === 'string' ? event.data
          : event.data && typeof (event.data as { toString?: () => string }).toString === 'function' && typeof ArrayBuffer !== 'undefined' && !(event.data instanceof ArrayBuffer)
            ? String(event.data) : undefined;
        if (typeof raw !== 'string' || raw.length > 65536) return;
        try {
          const r = JSON.parse(raw) as ControlRequest;
          if (typeof r.id === 'string' && r.id.length < 128 && typeof r.method === 'string') handler(r);
        } catch { /* invalid control envelope */ }
      };
      socket.addEventListener('message', listener);
      return () => socket.removeEventListener('message', listener);
    },
    send(response) {
      if (socket.readyState !== 1 || socket.bufferedAmount > maxBufferedBytes) throw new Error('diagnostic-transport-busy');
      const data = JSON.stringify(response);
      if (data.length * 2 > maxMessageBytes) throw new Error('diagnostic-export-too-large');
      socket.send(data);
    }
  };
}

/** Adapts a Web or Node MessagePort / DedicatedWorkerGlobalScope for forwarding control without Worker WebSockets. */
export function messagePortChannel(port: {
  postMessage(message: unknown): void;
  start?(): void;
  addEventListener?(type: string, listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: string, listener: (event: { data: unknown }) => void): void;
  on?(event: string, listener: (value: unknown) => void): void;
  off?(event: string, listener: (value: unknown) => void): void;
}, maxMessageBytes = 32 * 1024 * 1024): ControlChannel {
  return {
    subscribe(handler) {
      const dispatch = (payload: unknown) => {
        const candidate = typeof payload === 'string' ? (() => { try { return JSON.parse(payload); } catch { return undefined; } })() : payload;
        if (!candidate || typeof candidate !== 'object') return;
        const r = candidate as ControlRequest;
        if (typeof r.id === 'string' && r.id.length < 128 && typeof r.method === 'string') handler(r);
      };
      if (typeof port.addEventListener === 'function' && typeof port.removeEventListener === 'function') {
        const listener = (event: { data: unknown }) => dispatch(event.data);
        port.addEventListener('message', listener);
        port.start?.();
        return () => port.removeEventListener!('message', listener);
      }
      if (typeof port.on === 'function' && typeof port.off === 'function') {
        port.on('message', dispatch);
        port.start?.();
        return () => port.off!('message', dispatch);
      }
      throw new Error('unsupported-message-port');
    },
    send(response) {
      const serialized = JSON.stringify(response);
      if (serialized.length * 2 > maxMessageBytes) throw new Error('diagnostic-export-too-large');
      port.postMessage(response);
    }
  };
}

export interface ConnectableProfiler {
  inspect(): unknown;
  attachControl(channel: ControlChannel): () => void;
}

/**
 * Connects a profiler to the local control service, sending the token in the initial
 * handshake frame rather than the WebSocket URL query string, with optional auto-reconnect
 * and clean disposal.
 */
export function connect(profiler: ConnectableProfiler, options: ConnectOptions): ConnectionHandle;
export function connect(options: ConnectOptions & { profiler: ConnectableProfiler }): ConnectionHandle;
export function connect(
  first: ConnectableProfiler | (ConnectOptions & { profiler: ConnectableProfiler }),
  second?: ConnectOptions
): ConnectionHandle {
  const profiler = 'attachControl' in first ? first : first.profiler;
  const opts = ('attachControl' in first ? second! : first) as ConnectOptions;
  if (!profiler || !opts?.endpoint || !opts?.token) throw new Error('connect-requires-profiler-endpoint-and-token');
  const WS = opts.WebSocketImpl ?? (globalThis as any).WebSocket;
  if (typeof WS !== 'function') throw new Error('websocket-unavailable');
  const reconnectCfg = opts.reconnect === false ? null : {
    initialDelayMs: typeof opts.reconnect === 'object' ? (opts.reconnect.initialDelayMs ?? 250) : 250,
    maxDelayMs: typeof opts.reconnect === 'object' ? (opts.reconnect.maxDelayMs ?? 5000) : 5000
  };
  let closed = false;
  let isConnected = false;
  let socket: any;
  let detach: (() => void) | undefined;
  let retryTimer: any;
  let attempt = 0;
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  let settledReady = false;
  const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => { /* prevent unhandled rejection when caller does not await ready */ });

  const cleanupSocket = () => {
    try { detach?.(); } catch { /* ignore */ }
    detach = undefined;
    isConnected = false;
  };
  const scheduleReconnect = (err?: unknown) => {
    if (closed) return;
    if (!reconnectCfg) {
      if (!settledReady) { settledReady = true; rejectReady(err instanceof Error ? err : new Error('websocket-connect-failed')); }
      return;
    }
    const base = Math.min(reconnectCfg.maxDelayMs, reconnectCfg.initialDelayMs * Math.pow(2, Math.min(attempt++, 6)));
    const delay = Math.round(base * (0.85 + Math.random() * 0.3));
    retryTimer = setTimeout(dial, delay);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
  };
  function dial() {
    if (closed) return;
    opts.onStateChange?.('connecting');
    let ws: any;
    try { ws = new WS(opts.endpoint); } catch (err) {
      opts.onStateChange?.('disconnected', err);
      scheduleReconnect(err);
      return;
    }
    socket = ws;
    let lastError: unknown;
    ws.addEventListener('error', (event: unknown) => {
      // Prevent unhandled error crashes in Workers; close handler drives retry.
      lastError = event;
    });
    ws.addEventListener('message', (ev: { data: unknown }) => {
      if (typeof ev.data !== 'string' || ev.data.length > 4096) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.helloAck?.ok) {
          isConnected = true;
          opts.onStateChange?.('connected');
          if (!settledReady) { settledReady = true; resolveReady(); }
        }
      } catch { /* handled by control channel */ }
    });
    ws.addEventListener('open', () => {
      if (closed || socket !== ws) { try { ws.close(); } catch {} return; }
      attempt = 0;
      detach = profiler.attachControl(websocketChannel(ws));
      try {
        ws.send(JSON.stringify({ auth: opts.token, hello: profiler.inspect() }));
      } catch (err) {
        lastError = err;
        try { ws.close(); } catch {}
      }
    });
    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      cleanupSocket();
      socket = undefined;
      if (closed) return;
      opts.onStateChange?.('disconnected', lastError);
      scheduleReconnect(lastError);
    });
  }
  dial();

  function close() {
    if (closed) return;
    closed = true;
    if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined; }
    cleanupSocket();
    const current = socket;
    socket = undefined;
    if (current) {
      try { if (current.readyState === 0 || current.readyState === 1) current.close(); } catch { /* ignore */ }
    }
    if (!settledReady) { settledReady = true; rejectReady(new Error('connection-closed')); }
    opts.onStateChange?.('closed');
  }

  const handle: ConnectionHandle = {
    get connected() { return isConnected; },
    ready,
    close
  };
  if (typeof Symbol !== 'undefined' && (Symbol as any).dispose) {
    (handle as any)[(Symbol as any).dispose] = close;
  }
  return handle;
}
