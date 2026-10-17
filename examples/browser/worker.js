import { createBrowserProfiler, websocketChannel } from '/sdk.js';
const host = { contract: 'lumio.observation/1' };
const profiler = createBrowserProfiler({ host, role: 'prediction-worker',
  build: { id: 'browser-example', mode: 'debug', codeEpoch: '1' },
  markers: [{ id: 1, name: 'worker-tick', kind: 'span' }] });
self.onmessage = async ({ data }) => {
  const socket = new WebSocket(`${data.endpoint}?token=${encodeURIComponent(data.token)}`);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  profiler.attachControl(websocketChannel(socket)); socket.send(JSON.stringify({ hello: profiler.inspect() }));
  setInterval(() => { const w = host.trace; if (w) { const id = w.begin(1); w.end(id); } }, 50);
};
