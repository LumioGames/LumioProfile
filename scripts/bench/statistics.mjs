export function random(seed = 789) {
  return () => { seed |= 0; seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };
}
export function quantile(xs, q) {
  if (!xs.length) return NaN;
  const sorted = xs.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
}
export function pairedRatio(pairs) {
  const a = pairs.reduce((n, p) => n + p[0], 0), b = pairs.reduce((n, p) => n + p[1], 0);
  return a > 0 ? (b / a - 1) * 100 : NaN;
}
// Resample paired blocks, not individual ticks: preserve within-block serial correlation.
export function interval(blocks, statistic, seed = 789, count = 1500) {
  if (!blocks.length) return [NaN, NaN];
  const next = random(seed), values = [];
  for (let i = 0; i < count; i++) {
    const sample = Array.from({ length: blocks.length }, () => blocks[Math.floor(next() * blocks.length)]);
    values.push(statistic(sample));
  }
  if (values.some(v => !Number.isFinite(v))) return [NaN, NaN];
  return [quantile(values, 0.025), quantile(values, 0.975)];
}
export function classify(ci, budget, noise = 0, sufficient = true) {
  if (!sufficient || !ci.every(Number.isFinite) || !Number.isFinite(noise)) return 'insufficient-evidence';
  if (ci[1] + noise <= budget) return 'passed';
  if (ci[0] - noise > budget) return 'failed';
  return 'insufficient-evidence';
}
const budgets = { off: { cpu: .2 }, stats: { cpu: 1, p99: .1 }, trace: { cpu: 5, p99: .5 }, 'trace-full': { cpu: 5, p99: .5 }, 'trace-ring': { cpu: 5, p99: .5 } };
const tailDiff = blocks => quantile(blocks.flatMap(b => b.map(p => p[1])), .99) - quantile(blocks.flatMap(b => b.map(p => p[0])), .99);
export function summarize(run) {
  const result = {};
  const measurements = Object.fromEntries(run.modes.map(mode => {
    const rows = run.results.filter(r => r.mode === mode);
    if (run.kind === 'paced') {
      const blocks = [];
      for (let i = 0; i < rows.length; i += 50) blocks.push(rows.slice(i, i + 50).map(r => [r.a.wallMs, r.b.wallMs]));
      return [mode, { rows, p99: { estimate: tailDiff(blocks), ci95: interval(blocks, tailDiff), unit: 'ms' } }];
    }
    const wallPairs = rows.map(r => [r.a.wallMs, r.b.wallMs]);
    const cpuPairs = rows.map(r => [r.a.cpuMs ?? NaN, r.b.cpuMs ?? NaN]);
    return [mode, { rows, wall: { estimate: pairedRatio(wallPairs), ci95: interval(wallPairs, pairedRatio), unit: '%' },
      cpu: { estimate: pairedRatio(cpuPairs), ci95: interval(cpuPairs, pairedRatio), unit: '%' } }];
  }));
  for (const mode of run.modes) {
    const m = measurements[mode], rows = m.rows;
    const metrics = {};
    for (const key of ['p99', 'cpu', 'wall']) if (m[key]) {
      const metric = m[key], control = measurements.noise[key];
      const noise = Math.max(...control.ci95.map(Math.abs)) + (key === 'p99' ? 2 * (run.environment?.clockResolutionMs ?? 0) : 0);
      const budget = budgets[mode]?.[key];
      const sufficient = run.kind === 'paced' ? rows.length >= 2000 : rows.length >= 32 && (key !== 'cpu' || rows.reduce((n, r) => n + (r.a.cpuMs ?? 0), 0) >= 1000);
      metrics[key] = { ...metric, noiseEnvelope: noise, budget: budget ?? null,
        decision: budget === undefined ? 'not-budgeted' : classify(metric.ci95, budget, noise, sufficient) };
    }
    result[mode] = { pairs: rows.length, metrics, distribution: run.kind === 'paced' ? 'individual ticks' : 'block mean tick costs; not individual tick p99',
      baselineMedianMs: quantile(rows.map(r => r.a.wallMs / r.ticks), .5), candidateMedianMs: quantile(rows.map(r => r.b.wallMs / r.ticks), .5),
      baselineP99Ms: quantile(rows.map(r => r.a.wallMs / r.ticks), .99), candidateP99Ms: quantile(rows.map(r => r.b.wallMs / r.ticks), .99) };
  }
  return result;
}
