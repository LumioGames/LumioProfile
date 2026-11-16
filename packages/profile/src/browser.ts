import { createProfiler, mergeMarkers } from './core.ts';
import type { Options, Clock, CollectorAdapter, AutoRecordData, CpuProfileData, CpuProfileNode, Fields } from './types.ts';
export type * from './types.ts';

export type BrowserOptions = Omit<Options, 'clock' | 'scheduler' | 'sourceId' | 'collectorAdapter'> & { sourceId?: string };

function supportsEntryType(entryType: string): boolean {
  const PO = (globalThis as any).PerformanceObserver;
  if (typeof PO !== 'function') return false;
  const supported = PO.supportedEntryTypes;
  return Array.isArray(supported) ? supported.includes(entryType) : false;
}

function measureClockResolutionMs(isolated: boolean): number {
  let prev = performance.now();
  let minDelta = Infinity;
  for (let i = 0; i < 256; i++) {
    const cur = performance.now();
    if (cur > prev) {
      minDelta = Math.min(minDelta, cur - prev);
      if (i > 16) break;
    }
    prev = cur;
  }
  if (Number.isFinite(minDelta) && minDelta > 0) return Number(minDelta.toFixed(6));
  return isolated ? 0.005 : 0.1;
}

function convertSelfProfile(trace: any, startedAt: number, stoppedAt: number, sampleIntervalUs: number): CpuProfileData {
  const frames: any[] = Array.isArray(trace?.frames) ? trace.frames : [];
  const stacks: any[] = Array.isArray(trace?.stacks) ? trace.stacks : [];
  const rawSamples: any[] = Array.isArray(trace?.samples) ? trace.samples : [];
  const nodes: CpuProfileNode[] = [{ id: 1, functionName: '(root)', hitCount: 0, children: [] }];
  const stackToNodeId = new Map<number, number>();
  function ensureStackNode(stackIdx: number): number {
    const existing = stackToNodeId.get(stackIdx);
    if (existing !== undefined) return existing;
    const st = stacks[stackIdx];
    if (!st) return 1;
    const parentNodeId = st.parentId !== undefined && st.parentId !== null ? ensureStackNode(st.parentId) : 1;
    const frame = frames[st.frameId] ?? {};
    const id = nodes.length + 1;
    const node: CpuProfileNode = {
      id,
      functionName: frame.name || '(anonymous)',
      url: frame.resourceId !== undefined && Array.isArray(trace?.resources) ? trace.resources[frame.resourceId] : undefined,
      lineNumber: typeof frame.line === 'number' ? frame.line : undefined,
      columnNumber: typeof frame.column === 'number' ? frame.column : undefined,
      parentId: parentNodeId,
      hitCount: 0,
      children: []
    };
    nodes.push(node);
    nodes[parentNodeId - 1].children!.push(id);
    stackToNodeId.set(stackIdx, id);
    return id;
  }
  const samples: number[] = [];
  const timestampsMs: number[] = [];
  for (const s of rawSamples) {
    if (!s || typeof s.timestamp !== 'number') continue;
    const nodeId = s.stackId !== undefined && s.stackId !== null ? ensureStackNode(s.stackId) : 1;
    nodes[nodeId - 1].hitCount = (nodes[nodeId - 1].hitCount ?? 0) + 1;
    samples.push(nodeId);
    timestampsMs.push(s.timestamp);
  }
  return {
    collector: 'browser-js-self-profiling',
    timeBasis: 'performance.now',
    sampleIntervalUs,
    startedAt,
    stoppedAt,
    nodes,
    samples,
    timestampsMs
  };
}

function createBrowserCollectors(): CollectorAdapter {
  const capabilities = {
    raf: typeof (globalThis as any).requestAnimationFrame === 'function' && typeof (globalThis as any).cancelAnimationFrame === 'function',
    longTasks: supportsEntryType('longtask'),
    longAnimationFrames: supportsEntryType('long-animation-frame'),
    cpuSampling: typeof (globalThis as any).Profiler === 'function'
  };
  return {
    capabilities,
    start(config, policy) {
      const autoRecords: AutoRecordData[] = [];
      const status: Record<string, string> = {};
      const observers: any[] = [];
      let rafId: number | undefined;
      let stopped = false;
      let autoDropped = 0;
      const startedAt = performance.now();
      const pushAuto = (entry: AutoRecordData) => {
        if (autoRecords.length >= 16384) { autoDropped++; return; }
        autoRecords.push(entry);
      };

      if (config.raf) {
        if (capabilities.raf) {
          status.raf = 'enabled';
          let lastRaf: number | undefined;
          const step = (ts: number) => {
            if (stopped) return;
            const now = Number.isFinite(ts) ? ts : performance.now();
            if (lastRaf !== undefined && now >= lastRaf) {
              pushAuto({ kind: 'raf', name: 'raf-frame', startTime: lastRaf, durationMs: now - lastRaf });
            }
            lastRaf = now;
            rafId = requestAnimationFrame(step);
          };
          rafId = requestAnimationFrame(step);
        } else {
          status.raf = 'unsupported-in-worker';
        }
      }

      if (config.longTasks) {
        if (capabilities.longTasks) {
          try {
            const obs = new PerformanceObserver(list => {
              for (const e of list.getEntries()) {
                pushAuto({ kind: 'longtask', name: e.name || 'longtask', startTime: e.startTime, durationMs: e.duration });
              }
            });
            obs.observe({ type: 'longtask', buffered: false } as PerformanceObserverInit);
            observers.push(obs);
            status.longTasks = 'enabled';
          } catch { status.longTasks = 'failed'; }
        } else {
          status.longTasks = 'unsupported';
        }
      }

      if (config.longAnimationFrames) {
        if (capabilities.longAnimationFrames) {
          try {
            const obs = new PerformanceObserver(list => {
              for (const e of list.getEntries() as any[]) {
                const fields: Record<string, string | number | boolean> = {};
                if (typeof e.blockingDuration === 'number') fields.blockingMs = e.blockingDuration;
                const topScript = Array.isArray(e.scripts) && e.scripts.length
                  ? [...e.scripts].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0]
                  : undefined;
                if (topScript) {
                  if (topScript.invoker) fields.invoker = String(topScript.invoker).slice(0, 95);
                  if (topScript.sourceFunctionName) fields.fn = String(topScript.sourceFunctionName).slice(0, 95);
                  if (topScript.sourceURL) fields.url = String(topScript.sourceURL).slice(0, 95);
                }
                pushAuto({
                  kind: 'long-animation-frame',
                  name: 'long-animation-frame',
                  startTime: e.startTime,
                  durationMs: e.duration,
                  fields: Object.keys(fields).length ? (fields as Fields) : undefined
                });
              }
            });
            obs.observe({ type: 'long-animation-frame', buffered: false } as PerformanceObserverInit);
            observers.push(obs);
            status.longAnimationFrames = 'enabled';
          } catch { status.longAnimationFrames = 'failed'; }
        } else {
          status.longAnimationFrames = 'unsupported';
        }
      }

      let jsProfiler: any;
      let sampleIntervalUs = 10000;
      if (config.cpuSampling) {
        if (policy.allowCpuSampling === false) {
          status.cpuSampling = 'disabled-by-policy';
        } else if (typeof (globalThis as any).Profiler === 'function') {
          sampleIntervalUs = typeof config.cpuSampling === 'object' && config.cpuSampling.sampleIntervalUs
            ? Math.max(1000, config.cpuSampling.sampleIntervalUs)
            : 10000;
          try {
            jsProfiler = new (globalThis as any).Profiler({
              sampleInterval: Math.max(1, Math.round(sampleIntervalUs / 1000)),
              maxBufferSize: 100000
            });
            status.cpuSampling = 'enabled';
          } catch {
            status.cpuSampling = 'failed-requires-js-profiling-policy';
          }
        } else {
          status.cpuSampling = 'unsupported-requires-document-policy-js-profiling';
        }
      }

      return {
        stop() {
          stopped = true;
          if (rafId !== undefined) { try { cancelAnimationFrame(rafId); } catch {} rafId = undefined; }
          for (const obs of observers) {
            try {
              const tail = typeof obs.takeRecords === 'function' ? obs.takeRecords() : [];
              for (const e of tail) {
                if (e.entryType === 'longtask') pushAuto({ kind: 'longtask', name: e.name || 'longtask', startTime: e.startTime, durationMs: e.duration });
                else if (e.entryType === 'long-animation-frame') pushAuto({ kind: 'long-animation-frame', name: 'long-animation-frame', startTime: e.startTime, durationMs: e.duration });
              }
              obs.disconnect();
            } catch {}
          }
          const stoppedAt = performance.now();
          if (jsProfiler && typeof jsProfiler.stop === 'function') {
            return Promise.resolve(jsProfiler.stop()).then(
              trace => ({
                autoRecords,
                cpuProfile: convertSelfProfile(trace, startedAt, stoppedAt, sampleIntervalUs),
                status,
                autoDropped
              }),
              () => {
                status.cpuSampling = 'stop-failed';
                return { autoRecords, status, autoDropped };
              }
            );
          }
          return { autoRecords, status, autoDropped };
        }
      };
    }
  };
}

export function createBrowserProfiler(options: BrowserOptions) {
  const sourceId = options.sourceId ?? globalThis.crypto.randomUUID();
  const isolated = Boolean((globalThis as any).crossOriginIsolated);
  let measuredPrecision = false;
  const clock: Clock = {
    id: `${sourceId}/performance`,
    epoch: '1',
    unit: 'ms',
    basis: 'performance.now',
    rawOrigin: String(performance.timeOrigin),
    rawUnit: 'ms',
    now() {
      const t = performance.now();
      if (!measuredPrecision) {
        measuredPrecision = true;
        clock.precisionMs = measureClockResolutionMs(isolated);
      }
      return t;
    }
  };
  return createProfiler({
    ...options,
    sourceId,
    clock,
    collectorAdapter: createBrowserCollectors(),
    environment: {
      runtime: typeof document === 'undefined' ? 'browser-worker' : 'browser-main',
      visibilityAtAttach: typeof document === 'undefined' ? 'unavailable' : document.visibilityState,
      crossOriginIsolated: isolated,
      expectedClockResolutionMs: isolated ? 0.005 : 0.1,
      userAgent: typeof navigator === 'undefined' ? 'unavailable' : navigator.userAgent,
      ...options.environment
    },
    scheduler: { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }
  });
}

export { mergeMarkers } from './core.ts';
export { websocketChannel, messagePortChannel, connect } from './transport.ts';
