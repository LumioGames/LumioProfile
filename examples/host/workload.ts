import { profileHost } from './observation.ts';
declare const PROFILE_COMPILED: boolean;
export function step(state: number) {
  if (PROFILE_COMPILED) {
    const writer = profileHost.trace;
    if (writer) writer.event(101, { tick: state });
  }
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}
