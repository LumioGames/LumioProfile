import { randomUUID } from 'node:crypto';
import { threadId, isMainThread } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createProfiler } from './core.ts';
import type { Options, Clock } from './types.ts';
export type NodeOptions = Omit<Options, 'clock' | 'scheduler' | 'sourceId'> & { sourceId?: string };
export function createNodeProfiler(options: NodeOptions) {
  const sourceId = options.sourceId ?? randomUUID();
  // Use the native millisecond clock directly; avoid per-event BigInt creation/subtraction.
  // timeOrigin is descriptive only: cross-source arithmetic still requires calibration.
  const clock: Clock = { id: `${sourceId}/performance`, epoch: '1', unit: 'ms', rawUnit: 'ms', basis: 'node.performance.now',
    now() { const t = performance.now(); clock.rawOrigin ??= String(performance.timeOrigin); return t; } };
  return createProfiler({ ...options, sourceId, clock,
    environment: { runtime: 'node', version: process.version, pid: process.pid, threadId, isMainThread, ...options.environment },
    scheduler: { set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) } });
}
export { websocketChannel } from './transport.ts';
