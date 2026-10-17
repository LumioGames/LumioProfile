import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createNodeProfiler, websocketChannel } from '../packages/profile/src/node.ts';
import { exportCapture, readCapture } from '../packages/profile-tools/src/bundle.ts';
import { perfettoTraces } from '../packages/profile-tools/src/perfetto.ts';
import { createService } from '../packages/profile-tools/src/service.ts';

const opts = () => ({ host: { contract: 'lumio.observation/1' }, markers: [{ id: 1, name: 'work', kind: 'span' }], role: 'room', build: { id: 'fixture', mode: 'debug', codeEpoch: '1' } });
test('export preserves immutable raw evidence and produces a native Perfetto trace', async () => {
  const o = opts(), p = createNodeProfiler(o), prep = p.prepare({ mode: 'trace', durationMs: 1000 });
  p.start({ token: prep.token, requestId: 'r', captureId: 'capture' });
  const id = o.host.trace.begin(1, { operationKey: 's/42' }); o.host.trace.end(id); p.stop();
  const raw = { sources: [p.snapshot()], calibrations: [] };
  const traces = perfettoTraces(raw); assert.ok(traces, 'Perfetto conversion must exist');
  assert.ok(traces[0].bytes.length > 30);
  assert.equal(traces[0].bytes[0], 10, 'native Trace.packet protobuf field');
  await mkdir('artifacts/tests', { recursive: true });
  const parent = await mkdtemp('artifacts/tests/bundle-');
  const out = join(parent, 'capture');
  const manifest = await exportCapture(raw, out); assert.ok(manifest);
  assert.equal((await readCapture(out)).sources[0].records.length, 2);
  await assert.rejects(exportCapture(raw, out), /exist/i);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(out, 'raw.json'), '{}');
  await assert.rejects(readCapture(out), /integrity/);
});
test('Agent can discover, start, stop and export an explicitly connected source', async () => {
  await mkdir('artifacts/tests', { recursive: true });
  const service = await createService({ port: 0, token: 'fixture-local-secret', outputRoot: 'artifacts/tests' });
  assert.ok(service, 'control service must exist');
  const socket = new WebSocket(service.wsUrl + '?token=fixture-local-secret');
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  const o = opts(), p = createNodeProfiler(o), detach = p.attachControl(websocketChannel(socket));
  socket.send(JSON.stringify({ hello: p.inspect() }));
  async function api(method, params = {}) {
    const response = await fetch(service.url + '/api/' + method, { method: 'POST', headers: { authorization: 'Bearer fixture-local-secret', 'content-type': 'application/json' }, body: JSON.stringify(params) });
    assert.equal(response.status, 200); return response.json();
  }
  try {
    await new Promise(r => setTimeout(r, 30));
    const targets = await api('targets'); assert.equal(targets.length, 1);
    const plan = await api('prepare', { targets: [targets[0].sourceId], config: { mode: 'trace', durationMs: 5000 } });
    assert.equal(o.host.trace, undefined);
    const started = await api('start', { planId: plan.planId, requestId: 'agent-r1' });
    assert.ok(started.captureId);
    const id = o.host.trace.begin(1); o.host.trace.end(id);
    const stops = await Promise.all([api('stop', { captureId: started.captureId }), api('stop', { captureId: started.captureId })]);
    assert.ok(stops.every(s => s.state === 'stopped'));
    const [exported, again] = await Promise.all([api('export', { captureId: started.captureId }), api('export', { captureId: started.captureId })]);
    assert.equal(exported.path, again.path);
    assert.ok(exported.path);
    assert.equal((await readCapture(exported.path)).sources[0].records.length, 2);
    const unauthorized = await fetch(service.url + '/api/targets', { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);
  } finally { detach(); socket.close(); await service.close(); }
});
