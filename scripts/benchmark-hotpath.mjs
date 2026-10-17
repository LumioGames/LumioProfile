// Diagnostic amplification only. This is NOT a gameplay CPU/p99 budget test.
// Example: node --cpu-prof --cpu-prof-dir=artifacts/benchmark scripts/benchmark-hotpath.mjs trace
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const sdk = process.argv[3] ? pathToFileURL(resolve(process.argv[3])) : new URL('../packages/profile/dist/node.js', import.meta.url);
const { createNodeProfiler } = await import(sdk.href);
const mode = process.argv[2] ?? 'trace';
if (!['stats', 'trace'].includes(mode)) throw new Error('expected-stats-or-trace');
const host = { contract: 'lumio.observation/1' };
const p = createNodeProfiler({ host, role: 'hotpath-diagnostic', build: { id: 'diagnostic', mode: 'debug', codeEpoch: '1' },
  markers: [{ id: 1, name: 'scope', kind: 'span' }, { id: 2, name: 'count', kind: 'counter' },
    { id: 3, name: 'gauge', kind: 'gauge' }, { id: 4, name: 'distribution', kind: 'histogram', buckets: [2, 5, 8] }] });
const plan = p.prepare({ mode, durationMs: 60000, overflowPolicy: 'overwrite-oldest-chunk' });
if (!p.start({ token: plan.token, requestId: 'r', captureId: 'c' }).ok) throw new Error('start-failed');
function run(n) {
  if (mode === 'trace') for (let i = 0; i < n; i++) { const w = host.trace; const id = w.begin(1); w.end(id); }
  else for (let i = 0; i < n; i++) { const w = host.stats; w.add(2, 1); w.gauge(3, i); w.observe(4, i % 12); }
}
run(200000);
const t = performance.now(); run(6000000); const elapsedMs = performance.now() - t;
p.stop(); console.log(JSON.stringify({ diagnosticOnly: true, mode, elapsedMs, operations: 6000000, status: p.status() })); p.release();
