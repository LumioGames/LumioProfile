import { createProfiler } from './core.ts';
import type { Options } from './types.ts';
export type BrowserOptions = Omit<Options, 'clock' | 'scheduler' | 'sourceId'> & { sourceId?: string };
export function createBrowserProfiler(options: BrowserOptions) {
  const sourceId = options.sourceId ?? globalThis.crypto.randomUUID();
  return createProfiler({ ...options, sourceId,
    clock: { id: `${sourceId}/performance`, epoch: '1', unit: 'ms', basis: 'performance.now', now: () => performance.now(), rawOrigin: String(performance.timeOrigin), rawUnit: 'ms' },
    environment: { runtime: typeof document === 'undefined' ? 'browser-worker' : 'browser-main',
      visibilityAtAttach: typeof document === 'undefined' ? 'unavailable' : document.visibilityState,
      userAgent: typeof navigator === 'undefined' ? 'unavailable' : navigator.userAgent, ...options.environment },
    scheduler: { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) } });
}
export { websocketChannel } from './transport.ts';
