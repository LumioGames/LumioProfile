import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { createNodeProfiler, websocketChannel } from '@lumio/profile/node';
import { createService } from '@lumio/profile-tools';
const execute = promisify(execFile);
await mkdir('artifacts/node', { recursive: true }); await mkdir('.cache', { recursive: true });
const directory = await mkdtemp('artifacts/node/demo-'), token = randomUUID();
const tokenFile = resolve('.cache', 'demo-token-' + randomUUID()); await writeFile(tokenFile, token);
const service = await createService({ port: 0, token, outputRoot: directory });
const host = { contract: 'lumio.observation/1' };
const profiler = createNodeProfiler({ host, role: 'ds-host', markers: [{ id: 1, name: 'message-send', kind: 'link', relation: 'causes' }], build: { id: 'node-demo', mode: 'debug', codeEpoch: '1' }, environment: { synthetic: true } });
const socket = new WebSocket(`${service.wsUrl}?token=${token}`);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
profiler.attachControl(websocketChannel(socket)); socket.send(JSON.stringify({ hello: profiler.inspect() }));
const worker = new Worker(new URL('./room.mjs', import.meta.url), { workerData: { endpoint: service.wsUrl, token } });
await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
let seq = 0;
const jobs = setInterval(() => { const job = { seq: ++seq, key: 'demo-session/' + seq }; const w = host.trace; if (w) w.link(1, job.key + '/message', 'out', { operationKey: job.key }); worker.postMessage(job); }, 80);
async function cli(...args) {
  const result = await execute(process.execPath, ['packages/profile-tools/dist/cli.js', ...args, '--url', service.url, '--token-file', tokenFile], { timeout: 30000 });
  return JSON.parse(result.stdout);
}
try {
  const targets = await cli('targets'); assert.equal(targets.length, 2);
  const planFile = join(directory, 'plan.json');
  await cli('prepare', '--targets', targets.map(t => t.sourceId).join(','), '--mode', 'trace', '--duration', '4000', '--plan', planFile);
  const capture = await cli('start', '--plan', planFile, '--request-id', randomUUID());
  await new Promise(r => setTimeout(r, 1400));
  const status = await cli('status', '--capture', capture.captureId);
  await cli('stop', '--capture', capture.captureId); const exported = await cli('export', '--capture', capture.captureId);
  const analysis = await cli('analyze', exported.path, '--query', 'queues');
  assert.ok(analysis.results.some(r => r.rows.length > 0));
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ passed: true, environment: 'real Node main + Worker; synthetic workload', status, exported, analysis }, null, 2));
  console.log(JSON.stringify({ passed: true, capture: exported.path, sources: 2, agentInterface: 'actual CLI lifecycle + Trace Processor query' }));
} finally { clearInterval(jobs); await worker.terminate(); socket.close(); await service.close(); await unlink(tokenFile); }
