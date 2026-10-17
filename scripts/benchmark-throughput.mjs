// Compatibility entry: workload and analysis are shared with the paced benchmark.
process.argv.push('--kind', 'throughput');
await import('./benchmark.mjs');
