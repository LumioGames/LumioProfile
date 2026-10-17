import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { interval, pairedRatio } from './bench/statistics.mjs';
const before = process.argv[2];
if (!before) throw new Error('provide-the-saved-before-sdk-path');
const after = 'packages/profile/dist/node.js', results = [];
for (const mode of ['stats', 'trace']) for (let pair = 0; pair < 8; pair++) {
  const row = { mode, pair };
  for (const side of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
    row[side] = JSON.parse(execFileSync(process.execPath, ['scripts/benchmark-hotpath.mjs', mode, side === 'before' ? before : after], { encoding: 'utf8' }));
  }
  results.push(row);
}
const summaries = Object.fromEntries(['stats', 'trace'].map(mode => {
  const pairs = results.filter(r => r.mode === mode).map(r => [r.before.elapsedMs, r.after.elapsedMs]);
  return [mode, { wallChangePercent: pairedRatio(pairs), ci95: interval(pairs, pairedRatio), pairs }];
}));
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const report = { diagnosticOnly: true, node: process.version, before, after, hashes: { before: await sha(before), after: await sha(after) }, summaries, results };
const directory = `artifacts/benchmark/hotpath-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(directory, { recursive: true }); await writeFile(`${directory}/comparison.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ directory, summaries }));
