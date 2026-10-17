import { createBrowserProfiler, websocketChannel } from '/sdk.js';
const host = { contract: 'lumio.observation/1' };
const profiler = createBrowserProfiler({ host, role: 'client-main',
  build: { id: 'browser-example', mode: 'debug', codeEpoch: '1' },
  markers: [{ id: 1, name: 'raf-opportunity', kind: 'event', fields: ['visibility'] }, { id: 2, name: 'simulation', kind: 'span' }] });
let running = true, tick = 0;
function frame() {
  if (!running) return;
  const writer = host.trace;
  if (writer) {
    writer.event(1, { tick, fields: { visibility: document.visibilityState } });
    const id = writer.begin(2); let value = 1; for (let i = 0; i < 1000; i++) value = Math.imul(value, 1664525) + i; writer.end(id);
  }
  tick++; requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.startProfile = async ({ endpoint, token }) => {
  const socket = new WebSocket(`${endpoint}?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  profiler.attachControl(websocketChannel(socket)); socket.send(JSON.stringify({ hello: profiler.inspect() }));
  const worker = new Worker('/worker.js', { type: 'module' }); worker.postMessage({ endpoint, token });
  window.stopExample = () => { running = false; socket.close(); worker.terminate(); };
  return profiler.inspect();
};
window.profileStatus = () => profiler.status();
