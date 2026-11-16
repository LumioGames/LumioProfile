import { randomUUID } from 'node:crypto';
import { threadId, isMainThread } from 'node:worker_threads';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { createProfiler, mergeMarkers } from './core.ts';
import type { Options, Clock, CollectorAdapter, AutoRecordData, CpuProfileData, CpuProfileNode } from './types.ts';
export type * from './types.ts';

export type NodeOptions = Omit<Options, 'clock' | 'scheduler' | 'sourceId' | 'collectorAdapter'> & { sourceId?: string };

const GC_KINDS: Record<number, string> = {
  1: 'scavenge',
  2: 'mark-sweep-compact',
  4: 'incremental',
  8: 'weakcb',
  15: 'all'
};

function convertV8Profile(profile: any, perfStartMs: number, perfStopMs: number, sampleIntervalUs: number): CpuProfileData {
  const rawNodes: any[] = Array.isArray(profile?.nodes) ? profile.nodes : [];
  const parentById = new Map<number, number>();
  for (const n of rawNodes) {
    if (Array.isArray(n.children)) {
      for (const childId of n.children) parentById.set(childId, n.id);
    }
  }
  const nodes: CpuProfileNode[] = rawNodes.map(n => ({
    id: n.id,
    functionName: n.callFrame?.functionName || '(anonymous)',
    url: n.callFrame?.url || undefined,
    lineNumber: typeof n.callFrame?.lineNumber === 'number' && n.callFrame.lineNumber >= 0 ? n.callFrame.lineNumber + 1 : undefined,
    columnNumber: typeof n.callFrame?.columnNumber === 'number' && n.callFrame.columnNumber >= 0 ? n.callFrame.columnNumber + 1 : undefined,
    parentId: parentById.get(n.id),
    children: Array.isArray(n.children) ? n.children.slice() : undefined,
    hitCount: typeof n.hitCount === 'number' ? n.hitCount : 0
  }));
  const rawSamples: number[] = Array.isArray(profile?.samples) ? profile.samples : [];
  const deltas: number[] = Array.isArray(profile?.timeDeltas) ? profile.timeDeltas : [];
  const timestampsMs: number[] = [];
  let cursorUs = 0;
  for (let i = 0; i < rawSamples.length; i++) {
    cursorUs += deltas[i] ?? 0;
    const t = Math.min(perfStopMs, Math.max(perfStartMs, perfStartMs + cursorUs / 1000));
    timestampsMs.push(t);
  }
  return {
    collector: 'node-inspector-v8',
    timeBasis: 'node.performance.now',
    sampleIntervalUs,
    startedAt: perfStartMs,
    stoppedAt: perfStopMs,
    nodes,
    samples: rawSamples.slice(),
    timestampsMs,
    rawV8Profile: profile
  };
}

function createNodeCollectors(): CollectorAdapter {
  return {
    capabilities: { gc: true, cpuSampling: true },
    start(config, policy) {
      const autoRecords: AutoRecordData[] = [];
      const status: Record<string, string> = {};
      let autoDropped = 0;
      let gcObserver: PerformanceObserver | undefined;
      let inspectorSession: Session | undefined;
      let cpuStartMs = 0;
      let sampleIntervalUs = 1000;

      if (config.gc) {
        try {
          gcObserver = new PerformanceObserver(list => {
            for (const e of list.getEntries()) {
              if (autoRecords.length >= 16384) { autoDropped++; continue; }
              const kindNum = (e as any).detail?.kind as number | undefined;
              const gcKind = (kindNum !== undefined && GC_KINDS[kindNum]) || 'gc';
              autoRecords.push({
                kind: 'gc',
                name: `gc:${gcKind}`,
                startTime: e.startTime,
                durationMs: e.duration,
                fields: { gcKind }
              });
            }
          });
          gcObserver.observe({ entryTypes: ['gc'] });
          status.gc = 'enabled';
        } catch {
          status.gc = 'failed';
        }
      }

      if (config.cpuSampling) {
        if (policy.allowCpuSampling === false) {
          status.cpuSampling = 'disabled-by-policy';
        } else {
          sampleIntervalUs = typeof config.cpuSampling === 'object' && config.cpuSampling.sampleIntervalUs
            ? Math.max(100, config.cpuSampling.sampleIntervalUs)
            : 1000;
          try {
            const s = new Session();
            s.connect();
            s.post('Profiler.enable');
            s.post('Profiler.setSamplingInterval', { interval: sampleIntervalUs });
            cpuStartMs = performance.now();
            s.post('Profiler.start');
            inspectorSession = s;
            status.cpuSampling = 'enabled';
          } catch {
            try { inspectorSession?.disconnect(); } catch {}
            inspectorSession = undefined;
            status.cpuSampling = 'failed';
          }
        }
      }

      return {
        stop() {
          if (gcObserver) {
            try {
              for (const e of gcObserver.takeRecords()) {
                if (autoRecords.length >= 16384) { autoDropped++; continue; }
                const kindNum = (e as any).detail?.kind as number | undefined;
                const gcKind = (kindNum !== undefined && GC_KINDS[kindNum]) || 'gc';
                autoRecords.push({ kind: 'gc', name: `gc:${gcKind}`, startTime: e.startTime, durationMs: e.duration, fields: { gcKind } });
              }
              gcObserver.disconnect();
            } catch {}
          }
          let cpuProfile: CpuProfileData | undefined;
          if (inspectorSession) {
            try {
              let rawProfile: any;
              inspectorSession.post('Profiler.stop', (err, params) => {
                if (!err && params?.profile) rawProfile = params.profile;
              });
              const cpuStopMs = performance.now();
              inspectorSession.disconnect();
              if (rawProfile) {
                cpuProfile = convertV8Profile(rawProfile, cpuStartMs, cpuStopMs, sampleIntervalUs);
              } else {
                status.cpuSampling = 'empty-profile';
              }
            } catch {
              try { inspectorSession.disconnect(); } catch {}
              status.cpuSampling = 'stop-failed';
            }
          }
          return { autoRecords, cpuProfile, status, autoDropped };
        }
      };
    }
  };
}

export function createNodeProfiler(options: NodeOptions) {
  const sourceId = options.sourceId ?? randomUUID();
  // Use the native millisecond clock directly; avoid per-event BigInt creation/subtraction.
  // timeOrigin is descriptive only: cross-source arithmetic still requires calibration.
  const clock: Clock = {
    id: `${sourceId}/performance`,
    epoch: '1',
    unit: 'ms',
    rawUnit: 'ms',
    precisionMs: 0.001,
    basis: 'node.performance.now',
    now() { const t = performance.now(); clock.rawOrigin ??= String(performance.timeOrigin); return t; }
  };
  return createProfiler({
    ...options,
    sourceId,
    clock,
    collectorAdapter: createNodeCollectors(),
    environment: { runtime: 'node', version: process.version, pid: process.pid, threadId, isMainThread, ...options.environment },
    scheduler: { set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }
  });
}

export { mergeMarkers } from './core.ts';
export { websocketChannel, messagePortChannel, connect } from './transport.ts';
