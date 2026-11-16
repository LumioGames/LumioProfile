import { createWorkload, workload } from './workload.mjs';
import { random } from './statistics.mjs';
export const modes = ['noise', 'off', 'stats', 'trace', 'trace-full', 'trace-ring'];
const markers = [{ id: 1, name: 'system', kind: 'span' }, { id: 2, name: 'systems', kind: 'counter' },
  { id: 3, name: 'system-index', kind: 'gauge' }, { id: 4, name: 'index-distribution', kind: 'histogram', buckets: [2, 5, 8] },
  { id: 5, name: 'prefill', kind: 'event' }];
const bytes = 8 * 1024 * 1024;
export function createHarness(factory, env) {
  const work = createWorkload(), life = [], states = new Map();
  let checksum = 0, serial = 0;
  function setup(mode) {
    const previous = states.get(mode);
    if (previous) close(previous);
    const host = { contract: 'lumio.observation/1', trace: undefined, stats: undefined };
    const t0 = env.now();
    const p = mode === 'noise' ? undefined : factory({ host, sourceId: `benchmark-${mode}-${++serial}`, role: 'independent-benchmark', markers,
      build: { id: workload.id, mode: 'release', codeEpoch: '1' }, policy: { allowRelease: true } });
    const factoryMs = env.now() - t0;
    const t1 = env.now();
    if (mode !== 'noise' && mode !== 'off') {
      const plan = p.prepare({ mode: mode === 'stats' ? 'stats' : 'trace', durationMs: 60000, maxBytes: bytes,
        overflowPolicy: mode === 'trace-ring' ? 'overwrite-oldest-chunk' : 'drop-new-detail' });
      if (!plan.ok || !p.start({ token: plan.token, requestId: `r${serial}`, captureId: `c${serial}` }).ok) throw new Error('benchmark-capture-start');
    }
    const startMs = env.now() - t1;
    const prefillCount = (p?.status().capacity || Math.ceil(bytes / 80)) + 16;
    if (mode === 'trace-full' || mode === 'trace-ring') for (let i = 0; i < prefillCount; i++) host.trace.event(5);
    const state = { mode, host, p, factoryMs, startMs, ticks: 0 };
    states.set(mode, state);
    return state;
  }
  function close(s) {
    const before = s.p?.status();
    if (s.mode === 'trace' && before.quality.dropped !== 0) throw new Error('non-full-trace-overflowed');
    if (s.mode === 'trace-full' && before.quality.dropped === 0) throw new Error('full-trace-not-full');
    if (s.mode === 'trace-ring' && before.quality.overwritten === 0) throw new Error('ring-did-not-overwrite');
    if (s.mode === 'off' && before.allocatedBytes !== 0) throw new Error('off-buffer');
    if (s.mode !== 'noise' && s.mode !== 'off' && !before.active) throw new Error('capture-stopped-during-measurement');
    const t0 = env.now(); s.p?.stop(); const stopMs = env.now() - t0;
    const t1 = env.now(); s.p?.release(); const releaseMs = env.now() - t1;
    life.push({ mode: s.mode, factoryMs: s.factoryMs, startMs: s.startMs, stopMs, releaseMs,
      allocatedBytes: before?.allocatedBytes ?? 0, quality: before?.quality, ticks: s.ticks });
  }
  function tick(s, seed, baseline = false) {
    const value = baseline || s.mode === 'noise' ? work.baseline(seed) : work.observed(s.host, seed);
    checksum ^= value;
    return value;
  }
  function measure(s, seed, ticks, baseline) {
    const cpu = env.cpu?.(), t = env.now(); let value = 0;
    for (let i = 0; i < ticks; i++) value ^= tick(s, seed + i, baseline);
    const wallMs = env.now() - t, cpuMs = cpu === undefined ? undefined : env.cpu(cpu);
    if (!baseline) s.ticks += ticks;
    return { wallMs, cpuMs, checksum: value };
  }
  function measureWindow(mode, seed, baseline) {
    // Longer CPU windows reduce Windows counter quantization. Include capture lifecycle
    // and prefill costs rather than subtracting separately measured, noisy CPU values.
    const cpu = env.cpu(), t = env.now(); let value = 0;
    for (let block = 0; block < 8; block++) {
      const s = baseline || mode === 'noise' ? states.get('noise') : setup(mode);
      for (let i = 0; i < 256; i++) value ^= tick(s, seed + block * 256 + i, baseline);
      if (!baseline && mode !== 'noise') s.ticks += 256;
    }
    if (!baseline && mode !== 'noise') { close(states.get(mode)); states.delete(mode); }
    return { wallMs: env.now() - t, cpuMs: env.cpu(cpu), checksum: value };
  }
  async function run({ kind, rounds = kind === 'paced' ? 2000 : 64, seed = 20261016 }) {
    const next = random(seed), results = [], opportunities = [];
    // Warm all execution paths, then create fresh captures. Warmup never fills the measured trace.
    for (let n = 0; n < 8; n++) for (const mode of modes) {
      const s = setup(mode);
      for (let i = 0; i < 256; i++) { tick(s, i, true); tick(s, i); }
      await env.yield();
    }
    for (const mode of modes) setup(mode);
    const warmupLifecycleCount = life.length;
    const started = env.now(); let due = started;
    for (let round = 0; round < rounds; round++) {
      if (kind === 'paced') {
        due += 50;
        const delay = due - env.now(); if (delay > 0) await env.sleep(delay);
        opportunities.push({ round, latenessMs: env.now() - due, visibility: env.visibility?.() ?? 'not-applicable' });
        // Restart captures outside measured intervals; capacity/deadline assertions remain active.
        if (round > 0 && round % 128 === 0) for (const mode of modes) setup(mode);
      }
      // Fisher-Yates plus alternating AB/BA balances order; randomness is reproducible.
      const order = modes.slice();
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      for (const mode of order) {
        const s = kind === 'cpu-window' ? undefined : kind === 'paced' ? states.get(mode) : setup(mode);
        const ticks = kind === 'cpu-window' ? 2048 : kind === 'paced' ? 1 : 256;
        const measureSide = baseline => kind === 'cpu-window' ? measureWindow(mode, round * ticks, baseline) : measure(s, round * ticks, ticks, baseline);
        const candidateFirst = (round + modes.indexOf(mode)) % 2 === 0;
        let a, b;
        if (candidateFirst) { b = measureSide(false); a = measureSide(true); }
        else { a = measureSide(true); b = measureSide(false); }
        if (a.checksum !== b.checksum) throw new Error('workload-changed-by-observation');
        results.push({ mode, round, ticks, candidateFirst, a, b });
      }
      if (kind !== 'paced') await env.yield();
      if ((round + 1) % (kind === 'paced' ? 200 : 16) === 0) env.progress?.({ kind, round: round + 1, rounds });
    }
    for (const s of states.values()) close(s);
    states.clear();
    return { protocol: 'lumio.benchmark/2', kind, rounds, seed, modes, workload, elapsedMs: env.now() - started,
      checksum, results, lifecycle: life, warmupLifecycleCount, opportunities,
      design: { clock: 'local monotonic wall', budgetUnit: 'CPU% only where measured; wall p99 ms',
        paced: 'Each 50ms opportunity runs all six paired workloads sequentially; synthetic shared-process comparison, not six isolated servers.',
        throughput: '256 ticks per measured block; paired AB/BA; capture setup/stop/export excluded.',
        cpuWindow: 'Supplemental 2048-tick CPU windows include eight capture lifecycles and prefill/bookkeeping; conservative total cost, not isolated hot-path CPU.',
        warmup: '2048 ticks per mode and baseline, fresh capture every 256; warm/cold lifecycle retained separately.',
        trace: '8MiB; minimal span context; nonfull / prefilled drop-new / prefilled ring separately asserted.',
        statistics: '95% paired block bootstrap; paced blocks=50 opportunities; noise envelope from A/A control; no outlier removal.',
        limits: ['No GPU or physical-present data', 'No Unity/PuerTS runtime validation', 'No live control connection or export in hot interval', 'Cold means capture lifecycle, not cold process/module import', 'No forced GC; preceding setup may affect subsequent intervals'] } };
  }
  return { run };
}
