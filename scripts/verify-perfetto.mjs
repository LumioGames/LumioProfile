import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createProfiler } from '../packages/profile/src/core.ts';
import { exportCapture } from '../packages/profile-tools/src/bundle.ts';
import { runAnalysis } from '../packages/profile-tools/src/query.ts';
const processor = resolve('.cache/perfetto', process.platform === 'win32' ? 'trace_processor_shell.exe' : 'trace_processor_shell');
let time = 0;
const host = { contract: 'lumio.observation/1' };
const profiler = createProfiler({ host, sourceId: 'fixture-room', role: 'ds-room',
  markers: [{ id: 1, name: 'rules', kind: 'span' }, { id: 2, name: 'queue-enter', kind: 'link', relation: 'queue' }, { id: 3, name: 'queue-leave', kind: 'link', relation: 'queue' }],
  build: { id: 'deterministic-attribution-fixture', mode: 'debug', codeEpoch: '1' },
  clock: { id: 'fixture-clock', epoch: '1', unit: 'ms', now: () => time },
  scheduler: { set: () => 0, clear: () => {} }, environment: { synthetic: true, purpose: 'attribution oracle, not game reproduction' } });
const plan = profiler.prepare({ mode: 'trace', durationMs: 2000 });
assert.equal(plan.ok, true);
profiler.start({ token: plan.token, requestId: 'r', captureId: 'attribution-fixture' });
const ctx = { operationKey: 'session/player/42' };
host.trace.link(2, 'session/player/42/queue', 'out', ctx);
time = 1043; host.trace.link(3, 'session/player/42/queue', 'in', ctx);
const span = host.trace.begin(1, ctx); time = 1052; host.trace.end(span); profiler.stop();
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp('artifacts/perfetto-'); const directory = join(root, 'capture');
const manifest = await exportCapture({ sources: [profiler.snapshot()], calibrations: [] }, directory);
const queues = await runAnalysis(directory, 'queues', processor);
const hotspots = await runAnalysis(directory, 'hotspots', processor);
assert.equal(queues.results[0].rows[0].wait_ms, 1043);
assert.equal(hotspots.results[0].rows[0].total_wall_ms, 9);
assert.equal(hotspots.results[0].rows[0].observed_self_ms, 9);
const trace = join(directory, manifest.traces[0].path);
const flows = execFileSync(processor, ['query', trace, 'SELECT COUNT(*) AS n FROM flow;'], { encoding: 'utf8' });
assert.match(flows, /\n1\s*$/);
const errors = execFileSync(processor, ['query', trace, "SELECT name, value FROM stats WHERE severity = 'error' AND value > 0;"], { encoding: 'utf8' });
assert.equal(errors.trim().split('\n').length, 1);
await writeFile(join(root, 'verification.json'), JSON.stringify({ processor: queues.processorVersion, queues, hotspots, flows, errors }, null, 2));
console.log(JSON.stringify({ passed: true, capture: resolve(directory), queueWaitMs: 1043, executionMs: 9, flowCount: 1 }));
