// Shared verbatim by Node, Chrome, paced and throughput experiments.
export const workload = Object.freeze({ id: 'lcg-int32-32768-systems12-v2', systems: 12, elements: 32768,
  statsUpdatesPerTick: 36, traceRecordsPerTick: 24, context: 'none (minimal span contract)' });
export function createWorkload() {
  const data = new Int32Array(workload.elements);
  function work(seed) {
    let value = seed;
    for (let i = 0; i < data.length; i++) { value = (Math.imul(value, 1664525) + 1013904223) | 0; data[i] = value; }
    return value;
  }
  return {
    baseline(seed) { let checksum = 0; for (let i = 0; i < 12; i++) checksum ^= work(seed + i); return checksum; },
    observed(host, seed) {
      let checksum = 0;
      for (let i = 0; i < 12; i++) {
        const writer = host.trace, token = writer ? writer.begin(1) : 0;
        try { checksum ^= work(seed + i); } finally { if (writer) writer.end(token); }
        const stats = host.stats;
        if (stats) { stats.add(2, 1); stats.gauge(3, i); stats.observe(4, i); }
      }
      return checksum;
    }
  };
}
