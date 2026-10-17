import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { analyzeCapture, type CaptureInput } from './analysis.ts';
import { perfettoTraces } from './perfetto.ts';
const LIMIT = 128 * 1024 * 1024;
export const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export async function exportCapture(input: CaptureInput, directory: string) {
  const analysis = analyzeCapture(input);
  const raw = JSON.stringify(input);
  if (Buffer.byteLength(raw) > LIMIT / 2) throw new Error('raw-export-budget-exceeded');
  const traces = perfettoTraces(input);
  if (traces.reduce((sum, t) => sum + t.bytes.length, Buffer.byteLength(raw)) > LIMIT) throw new Error('export-budget-exceeded');
  const out = resolve(directory);
  await mkdir(out); // Never overwrite existing evidence.
  await mkdir(join(out, 'traces'));
  const files: Record<string, { sha256: string; bytes: number }> = {};
  async function save(name: string, data: string | Uint8Array) { await writeFile(join(out, name), data, { flag: 'wx' }); files[name] = { sha256: digest(data), bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.length }; }
  await save('raw.json', raw);
  const traceFiles: { path: string; domain: string; sourceIds: string[] }[] = [];
  for (let i = 0; i < traces.length; i++) {
    const path = `traces/domain-${i + 1}.pftrace`; await save(path, traces[i].bytes);
    traceFiles.push({ path, domain: traces[i].domain, sourceIds: traces[i].sourceIds });
  }
  await save('quality.json', JSON.stringify({ sources: analysis.sources.map(s => ({ sourceId: s.sourceId, quality: s.quality, environment: s.environment })), warnings: analysis.warnings, missingSources: analysis.missingSources, populationStatistics: analysis.populationStatistics, sourceLifecycle: input.sourceLifecycle }, null, 2));
  const manifest = { format: 'lumio.bundle/1', protocol: 'lumio.capture/1', converter: '0.1.0', queries: 'lumio.sql/1', captureId: analysis.captureId,
    createdAt: new Date().toISOString(), files, traces: traceFiles, rawImmutable: true, measuredGpu: false, physicalPresent: false };
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}
export async function readCapture(directory: string): Promise<CaptureInput> {
  const out = resolve(directory);
  if ((await stat(join(out, 'manifest.json'))).size > 1024 * 1024) throw new Error('manifest-budget');
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'lumio.bundle/1' || !manifest.files?.['raw.json']) throw new Error('incompatible-bundle');
  let total = 0;
  for (const [name, item] of Object.entries(manifest.files) as [string, { bytes: number; sha256: string }][]) {
    if (!/^(raw\.json|quality\.json|traces\/domain-\d+\.pftrace)$/.test(name)) throw new Error('invalid-bundle-path');
    const size = (await stat(join(out, name))).size; total += size;
    if (total > LIMIT || size !== item.bytes) throw new Error('integrity-or-budget');
    if (digest(await readFile(join(out, name))) !== item.sha256) throw new Error('integrity-mismatch');
  }
  const input: CaptureInput = JSON.parse(await readFile(join(out, 'raw.json'), 'utf8'));
  analyzeCapture(input); return input;
}
