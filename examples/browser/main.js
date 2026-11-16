import { createBrowserProfiler } from '/sdk.js';
const host = { contract: 'lumio.observation/1' };
const profiler = createBrowserProfiler({
  host,
  role: 'client-main',
  build: { id: 'browser-example', mode: 'debug', codeEpoch: '1' },
  markers: [
    { id: 1, name: 'raf-opportunity', kind: 'event', fields: ['visibility'] },
    { id: 2, name: 'simulation', kind: 'span' }
  ]
});
let running = true, tick = 0;
function frame() {
  if (!running) return;
  const writer = host.trace;
  if (writer) {
    writer.event(1, { tick, fields: { visibility: document.visibilityState } });
    const id = writer.begin(2, { tick });
    let value = 1;
    for (let i = 0; i < 4000; i++) value = Math.imul(value, 1664525) + i;
    writer.end(id);
  }
  tick++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.startProfile = async ({ endpoint, token }) => {
  const connection = profiler.connect({ endpoint, token });
  await connection.ready;
  const worker = new Worker('/worker.js', { type: 'module' });
  worker.addEventListener('error', () => { /* surface via missing target if worker fails */ });
  worker.postMessage({ endpoint, token });
  window.stopExample = () => {
    running = false;
    connection.close();
    worker.postMessage({ close: true });
    worker.terminate();
  };
  return profiler.inspect();
};
window.profileStatus = () => profiler.status();
