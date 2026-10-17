// Only diagnostic builds include this file in type checking and module resolution.
import { createBrowserProfiler } from '@lumio/profile/browser';
import { profileHost } from './observation.ts';
export const profiler = createBrowserProfiler({ host: profileHost, role: 'example',
  markers: [{ id: 101, name: 'step', kind: 'event' }], build: { id: 'example', mode: 'debug', codeEpoch: '1' } });
