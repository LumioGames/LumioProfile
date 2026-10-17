import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, interval, quantile, pairedRatio } from '../scripts/bench/statistics.mjs';
import { createWorkload } from '../scripts/bench/workload.mjs';

test('budget decisions distinguish uncertainty, failure and a measured pass', () => {
  assert.equal(classify([0.01, 0.08], 0.1, 0.01), 'passed');
  assert.equal(classify([0.12, 0.18], 0.1, 0.01), 'failed');
  assert.equal(classify([0.09, 0.12], 0.1, 0.01), 'insufficient-evidence');
  assert.equal(classify([0, 0.01], 0.1, 0, false), 'insufficient-evidence');
  assert.equal(classify([NaN, NaN], 0.1, 0), 'insufficient-evidence');
});

test('paired bootstrap preserves pairing and rejects an unmeasurable CPU baseline', () => {
  const pairs = Array.from({ length: 40 }, (_, i) => [i + 10, (i + 10) * 1.03]);
  const ci = interval(pairs, pairedRatio, 123);
  assert.ok(ci.every(n => Math.abs(n - 3) < 1e-9));
  assert.ok(Number.isNaN(pairedRatio([[0, 4], [0, 5]])));
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2);
});

test('the same workload has identical results with absent, Off, Stats and Trace seams', () => {
  const w = createWorkload();
  let begins = 0, ends = 0, stats = 0;
  const host = { trace: { begin() { begins++; return begins; }, end() { ends++; } },
    stats: { add() { stats++; }, gauge() { stats++; }, observe() { stats++; } } };
  for (const seed of [0, 1, 99]) {
    const expected = w.baseline(seed);
    assert.equal(w.observed({}, seed), expected);
    assert.equal(w.observed({ stats: host.stats }, seed), expected);
    assert.equal(w.observed({ trace: host.trace }, seed), expected);
  }
  assert.equal(begins, 36); assert.equal(ends, 36); assert.equal(stats, 108);
});
