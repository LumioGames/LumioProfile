import { createPuertsProfiler } from '@lumio/profile/puerts';
import type { ProfileHost } from '../../contracts/observation-v1.d.ts';

/** Shape exposed by the optional C# package. Actual PuerTS binding is not validated. */
interface NativeBridge {
  SourceId: string; ClockId: string; ClockEpoch: string;
  NowMilliseconds(): number;
  Schedule(callback: () => void, delayMs: number): number;
  Cancel(token: number): void;
}
export function attach(host: ProfileHost, native: NativeBridge) {
  return createPuertsProfiler({ host, role: 'client-script',
    markers: [{ id: 1, name: 'system', kind: 'span' }],
    build: { id: 'host-supplied-build-id', mode: 'debug', codeEpoch: '1' },
    nativeBridge: {
      sourceId: native.SourceId, clockId: native.ClockId, clockEpoch: native.ClockEpoch,
      nowMs: () => native.NowMilliseconds(),
      setTimeout: (fn, ms) => { const token = native.Schedule(fn, ms); if (!token) throw new Error('native-timer-budget'); return token; },
      clearTimeout: token => native.Cancel(token as number),
      environment: { validation: 'NOT tested in Unity/PuerTS; fill actual versions at integration' }
    } });
}
