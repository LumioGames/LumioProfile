import { createProfiler, mergeMarkers } from './core.ts';
import type { Options } from './types.ts';
export type * from './types.ts';

export interface NativeBridge {
  sourceId: string; clockId: string; clockEpoch: string;
  nowMs(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void;
  environment?: Record<string, string | number | boolean>;
}
export type PuertsOptions = Omit<Options, 'clock' | 'scheduler' | 'sourceId' | 'collectorAdapter'> & { nativeBridge: NativeBridge };
export function createPuertsProfiler(options: PuertsOptions) {
  const { nativeBridge: b, ...common } = options;
  // No browser/Node globals or native calls during attachment / Off observations.
  return createProfiler({ ...common, sourceId: b.sourceId,
    clock: { id: b.clockId, epoch: b.clockEpoch, unit: 'ms', basis: 'injected-native-monotonic', now: () => b.nowMs() },
    scheduler: { set: (fn, ms) => b.setTimeout(fn, ms), clear: h => b.clearTimeout(h) },
    environment: { runtime: 'puerts', validation: 'host-must-supply-actual-runtime-evidence', ...b.environment, ...options.environment } });
}
export { mergeMarkers } from './core.ts';
