import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { createNodeProfiler, websocketChannel } from '../packages/profile/src/node.ts';
import { createService } from '../packages/profile-tools/src/service.ts';
import { readCapture } from '../packages/profile-tools/src/bundle.ts';
import { analyzeCapture } from '../packages/profile-tools/src/analysis.ts';

async function fixture() {
  await mkdir('artifacts/tests', { recursive: true });
  const outputRoot = await mkdtemp('artifacts/tests/lifecycle-');
  const service = await createService({ port: 0, token: 'fixture-local-secret', outputRoot });
  const connected = [];
  async function waitFor(predicate) {
    const deadline = performance.now() + 1000;
    while (!await predicate()) {
      assert.ok(performance.now() < deadline, 'source registration condition timed out');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  async function connect(sourceId) {
    const host = { contract: 'lumio.observation/1' };
    const profiler = createNodeProfiler({ host, sourceId, role: 'room', markers: [{ id: 1, name: 'event', kind: 'event' }],
      build: { id: 'fixture', mode: 'debug', codeEpoch: '1' } });
    const socket = new WebSocket(service.wsUrl + '?token=fixture-local-secret');
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    const detach = profiler.attachControl(websocketChannel(socket));
    socket.send(JSON.stringify({ hello: profiler.inspect() }));
    await waitFor(async () => (await service.call('targets')).some(target => target.sourceId === sourceId));
    const source = { host, profiler, socket, detach, async close() {
      detach(); profiler.stop(); profiler.release();
      if (socket.readyState !== WebSocket.CLOSED) await new Promise(resolve => { socket.addEventListener('close', resolve, { once: true }); socket.close(); });
      await waitFor(async () => !(await service.call('targets')).some(target => target.sourceId === sourceId));
    } };
    connected.push(source); return source;
  }
  const prepare = targets => service.call('prepare', { targets, config: { mode: 'trace', durationMs: 5000, maxBytes: 65536 } });
  return { service, connect, prepare, async close() { for (const source of connected) if (source.socket.readyState !== WebSocket.CLOSED) await source.close(); await service.close(); } };
}

test('a prepared plan cannot start a replacement connection that reused its sourceId', async () => {
  const f = await fixture();
  try {
    const old = await f.connect('same-source');
    const plan = await f.prepare(['same-source']);
    await old.close();
    const replacement = await f.connect('same-source');
    assert.equal(replacement.profiler.prepare({ mode: 'trace', durationMs: 5000, maxBytes: 65536 }).ok, true);
    await assert.rejects(f.service.call('start', { planId: plan.planId, requestId: 'old-plan' }), /source-generation-mismatch/);
    assert.equal(replacement.profiler.status().active, false);
    assert.equal(replacement.profiler.status().allocatedBytes, 0);
  } finally { await f.close(); }
});

test('a replacement is not queried or exported as the selected connection', async () => {
  const f = await fixture();
  try {
    const old = await f.connect('same-source');
    const firstConnection = (await f.service.call('targets'))[0].controlConnection;
    assert.ok(firstConnection, 'target discovery must expose its control connection generation');
    const plan = await f.prepare(['same-source']);
    const started = await f.service.call('start', { planId: plan.planId, requestId: 'first-segment' });
    old.host.trace.event(1);
    await old.close();
    const replacement = await f.connect('same-source');
    const secondConnection = (await f.service.call('targets'))[0].controlConnection;
    assert.notEqual(firstConnection.id, secondConnection.id);
    const status = await f.service.call('status', { captureId: started.captureId });
    assert.equal(status.sources[0].state, 'unreachable');
    assert.match(status.sources[0].reason, /source-generation-mismatch/);
    const exported = await f.service.call('export', { captureId: started.captureId });
    const raw = await readCapture(exported.path);
    assert.deepEqual(raw.sources, []);
    assert.deepEqual(raw.missingSources, ['same-source']);
    assert.equal(raw.sourceLifecycle.selectedSources[0].connectionId, firstConnection.id);
    const registration = raw.sourceLifecycle.events.find(event => event.kind === 'registered');
    assert.equal(registration.connectionId, secondConnection.id);
    assert.equal(registration.selected, false);
    assert.equal(replacement.profiler.status().allocatedBytes, 0);
  } finally { await f.close(); }
});

test('a late Worker stays Off until explicitly selected in a separate segment', async () => {
  const f = await fixture();
  try {
    const main = await f.connect('main');
    const plan = await f.prepare(['main']);
    const first = await f.service.call('start', { planId: plan.planId, requestId: 'segment-one' });
    const worker = await f.connect('worker-generation-2');
    main.host.trace.event(1);
    assert.equal(worker.profiler.status().active, false);
    assert.equal(worker.profiler.status().allocatedBytes, 0);
    const exported = await f.service.call('export', { captureId: first.captureId });
    const raw = await readCapture(exported.path);
    assert.deepEqual(raw.sources.map(source => source.sourceId), ['main']);
    assert.deepEqual(raw.missingSources, []);
    assert.ok(raw.sourceLifecycle, 'late registration needs explicit lifecycle evidence');
    assert.equal(raw.sourceLifecycle.events[0].sourceId, 'worker-generation-2');
    assert.equal(raw.sourceLifecycle.events[0].selected, false);
    assert.ok(raw.sourceLifecycle.events[0].atMs >= raw.sourceLifecycle.captureStartedAt);
    assert.equal(raw.sourceLifecycle.droppedEvents, 0);
    const quality = JSON.parse(await readFile(exported.path + '/quality.json', 'utf8'));
    assert.deepEqual(quality.sourceLifecycle, raw.sourceLifecycle);
    const uncalibrated = analyzeCapture({ ...raw, calibrations: [] });
    assert.equal(uncalibrated.mappings.length, 0, 'lifecycle reference timestamps are not clock calibration samples');
    assert.ok(uncalibrated.events.every(event => !event.mapped));
    const next = await f.prepare(['main', 'worker-generation-2']);
    const second = await f.service.call('start', { planId: next.planId, requestId: 'segment-two' });
    worker.host.trace.event(1);
    const nextExport = await f.service.call('export', { captureId: second.captureId });
    const nextRaw = await readCapture(nextExport.path);
    assert.equal(nextRaw.sources.length, 2);
    assert.notEqual(first.captureId, second.captureId);
    assert.equal(nextRaw.sourceLifecycle.referenceId, raw.sourceLifecycle.referenceId);
    assert.ok(nextRaw.sourceLifecycle.captureStartedAt >= raw.sourceLifecycle.observationStoppedAt);
  } finally { await f.close(); }
});

test('connection lifecycle evidence is bounded and reports omitted metadata', async () => {
  const f = await fixture();
  try {
    await f.connect('main');
    const plan = await f.prepare(['main']);
    const first = await f.service.call('start', { planId: plan.planId, requestId: 'bounded-lifecycle' });
    for (let i = 0; i < 65; i++) { const transient = await f.connect('unselected-worker'); await transient.close(); }
    const status = await f.service.call('status', { captureId: first.captureId });
    assert.ok(status.sourceLifecycle, 'status must expose bounded lifecycle evidence');
    assert.equal(status.sourceLifecycle.events.length, 128);
    assert.equal(status.sourceLifecycle.droppedEvents, 2);
    status.sourceLifecycle.events.length = 0;
    assert.equal((await f.service.call('status', { captureId: first.captureId })).sourceLifecycle.events.length, 128);
    const exported = await f.service.call('export', { captureId: first.captureId });
    const raw = await readCapture(exported.path);
    assert.equal(raw.sourceLifecycle.events.length, 128);
    assert.equal(raw.sourceLifecycle.droppedEvents, 2);
    assert.deepEqual(raw.missingSources, []);
  } finally { await f.close(); }
});
