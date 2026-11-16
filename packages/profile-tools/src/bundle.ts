import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { analyzeCapture, type AnalysisResult, type CaptureInput } from './analysis.ts';
import { perfettoTraces } from './perfetto.ts';

const LIMIT = 512 * 1024 * 1024;
export const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

export async function exportCapture(input: CaptureInput, directory: string) {
  const analysis = analyzeCapture(input);
  const raw = JSON.stringify(input);
  if (Buffer.byteLength(raw) > LIMIT / 2) throw new Error('raw-export-budget-exceeded');
  const traces = perfettoTraces(input, analysis);
  if (traces.reduce((sum, t) => sum + t.bytes.length, Buffer.byteLength(raw)) > LIMIT) throw new Error('export-budget-exceeded');
  const out = resolve(directory);
  await mkdir(out); // Never overwrite existing evidence.
  await mkdir(join(out, 'traces'));
  const files: Record<string, { sha256: string; bytes: number }> = {};
  async function save(name: string, data: string | Uint8Array) {
    await writeFile(join(out, name), data, { flag: 'wx' });
    files[name] = { sha256: digest(data), bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.length };
  }
  await save('raw.json', raw);
  const traceFiles: { path: string; domain: string; sourceIds: string[]; fallbackReasons?: Record<string, string> }[] = [];
  for (let i = 0; i < traces.length; i++) {
    const path = `traces/domain-${i + 1}.pftrace`;
    await save(path, traces[i].bytes);
    traceFiles.push({
      path,
      domain: traces[i].domain,
      sourceIds: traces[i].sourceIds,
      ...(traces[i].fallbackReasons ? { fallbackReasons: traces[i].fallbackReasons } : {})
    });
  }
  const cpuProfiles: { path: string; sourceId: string; streamId: string; collector: string }[] = [];
  const sourcesWithCpu = analysis.sources.filter(s => s.cpuProfile);
  if (sourcesWithCpu.length > 0) {
    await mkdir(join(out, 'native'));
    for (let i = 0; i < sourcesWithCpu.length; i++) {
      const s = sourcesWithCpu[i];
      const path = `native/cpu-${i + 1}.cpuprofile`;
      const payload = JSON.stringify(s.cpuProfile!.rawV8Profile ?? s.cpuProfile);
      await save(path, payload);
      cpuProfiles.push({ path, sourceId: s.sourceId, streamId: s.streamId, collector: s.cpuProfile!.collector });
    }
  }
  await save('quality.json', JSON.stringify({
    sources: analysis.sources.map(s => ({
      sourceId: s.sourceId,
      streamId: s.streamId,
      clock: s.clock,
      quality: s.quality,
      collectorStatus: s.collectorStatus,
      environment: s.environment
    })),
    domainDiagnostics: analysis.domainDiagnostics,
    warnings: analysis.warnings,
    missingSources: analysis.missingSources,
    populationStatistics: analysis.populationStatistics,
    sourceLifecycle: input.sourceLifecycle
  }, null, 2));
  const manifest = {
    format: 'lumio.bundle/1',
    protocol: 'lumio.capture/1',
    converter: '0.2.0',
    queries: 'lumio.sql/1',
    captureId: analysis.captureId,
    createdAt: new Date().toISOString(),
    files,
    traces: traceFiles,
    ...(cpuProfiles.length ? { cpuProfiles } : {}),
    domainDiagnostics: analysis.domainDiagnostics,
    rawImmutable: true,
    measuredGpu: false,
    physicalPresent: false
  };
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}

export async function readCaptureWithAnalysis(directory: string): Promise<{ input: CaptureInput; analysis: AnalysisResult }> {
  const out = resolve(directory);
  if ((await stat(join(out, 'manifest.json'))).size > 1024 * 1024) throw new Error('manifest-budget');
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'lumio.bundle/1' || !manifest.files?.['raw.json']) throw new Error('incompatible-bundle');
  let total = 0;
  for (const [name, item] of Object.entries(manifest.files) as [string, { bytes: number; sha256: string }][]) {
    if (!/^(raw\.json|quality\.json|traces\/domain-\d+\.pftrace|native\/cpu-\d+\.cpuprofile)$/.test(name)) throw new Error('invalid-bundle-path');
    const size = (await stat(join(out, name))).size;
    total += size;
    if (total > LIMIT || size !== item.bytes) throw new Error('integrity-or-budget');
    if (digest(await readFile(join(out, name))) !== item.sha256) throw new Error('integrity-mismatch');
  }
  const input: CaptureInput = JSON.parse(await readFile(join(out, 'raw.json'), 'utf8'));
  const analysis = analyzeCapture(input);
  return { input, analysis };
}

export async function readCapture(directory: string): Promise<CaptureInput> {
  const { input } = await readCaptureWithAnalysis(directory);
  return input;
}
