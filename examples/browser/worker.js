import { createBrowserProfiler } from '/sdk.js';
const host = { contract: 'lumio.observation/1' };
const profiler = createBrowserProfiler({
  host,
  role: 'prediction-worker',
  build: { id: 'browser-example', mode: 'debug', codeEpoch: '1' },
  markers: [{ id: 1, name: 'worker-tick', kind: 'span' }]
});
let connection;
let timer;
self.onmessage = async ({ data }) => {
  if (data?.close) {
    if (timer) clearInterval(timer);
    connection?.close();
    return;
  }
  connection?.close();
  connection = profiler.connect({
    endpoint: data.endpoint,
    token: data.token,
    onStateChange(state, error) {
      if (state === 'disconnected' && error) {
        // Reconnection is automatic and bounded; never crash worker loop on transient socket errors.
      }
    }
  });
  try { await connection.ready; } catch { return; }
  if (!timer) {
    timer = setInterval(() => {
      const w = host.trace;
      if (w) {
        const id = w.begin(1);
        let acc = 1;
        for (let i = 0; i < 2000; i++) acc = Math.imul(acc, 1664525) + i;
        w.end(id);
      }
    }, 50);
  }
};
