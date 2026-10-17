import { parentPort, workerData } from 'node:worker_threads';
import { createNodeProfiler, websocketChannel } from '@lumio/profile/node';
const host = { contract: 'lumio.observation/1' };
const profiler = createNodeProfiler({ host, role: 'ds-room', build: { id: 'node-demo', mode: 'debug', codeEpoch: '1' },
  markers: [{ id: 1, name: 'rules', kind: 'span' }, { id: 2, name: 'message-receive', kind: 'link', relation: 'causes' },
    { id: 3, name: 'room-enqueue', kind: 'link', relation: 'queue' }, { id: 4, name: 'room-dequeue', kind: 'link', relation: 'queue' }], environment: { synthetic: true, tickHz: 20 } });
const socket = new WebSocket(`${workerData.endpoint}?token=${encodeURIComponent(workerData.token)}`);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
profiler.attachControl(websocketChannel(socket)); socket.send(JSON.stringify({ hello: profiler.inspect() }));
const queue = [];
parentPort.on('message', job => { queue.push(job); const w = host.trace; if (w) { const ctx = { operationKey: job.key }; w.link(2, job.key + '/message', 'in', ctx); w.link(3, job.key + '/queue', 'out', ctx); } });
setInterval(() => {
  const job = queue.shift(); if (!job) return;
  const w = host.trace; let id = 0;
  if (w) { w.link(4, job.key + '/queue', 'in', { operationKey: job.key }); id = w.begin(1, { operationKey: job.key }); }
  try { let state = job.seq; for (let i = 0; i < 10000; i++) state = Math.imul(state, 1664525) + i; parentPort.postMessage({ seq: job.seq, state }); }
  finally { if (w) w.end(id); }
}, 50);
parentPort.postMessage({ ready: true });
