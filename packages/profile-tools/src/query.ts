import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeCapture } from './analysis.ts';
import { readCapture } from './bundle.ts';
const execute = promisify(execFile);
export const QUERY_VERSION = 'lumio.sql/1';
const common = `WITH observed AS (
 SELECT id, ts, dur, name, track_id,
   EXTRACT_ARG(arg_set_id, 'debug.lumioKind') AS kind,
   EXTRACT_ARG(arg_set_id, 'debug.operationKey') AS operation_key,
   EXTRACT_ARG(arg_set_id, 'debug.correlationKey') AS correlation_key,
   EXTRACT_ARG(arg_set_id, 'debug.observedSelfMs') AS observed_self_ms,
   EXTRACT_ARG(arg_set_id, 'debug.localDurationMs') AS local_duration_ms,
   EXTRACT_ARG(arg_set_id, 'debug.measurementKind') AS measurement_kind,
   EXTRACT_ARG(arg_set_id, 'debug.evidence') AS evidence,
   EXTRACT_ARG(arg_set_id, 'debug.ref') AS event_ref
   ,EXTRACT_ARG(arg_set_id, 'debug.sourceId') AS source_id
   ,EXTRACT_ARG(arg_set_id, 'debug.markerId') AS marker_id
   ,EXTRACT_ARG(arg_set_id, 'debug.buildId') AS build_id
   ,EXTRACT_ARG(arg_set_id, 'debug.sourceFile') AS source_file
   ,EXTRACT_ARG(arg_set_id, 'debug.sourceLine') AS source_line
 FROM slice
)`;
export function querySql(name: string, key?: string): string {
  const prefix = `/* ${QUERY_VERSION}: same query for Agent and Perfetto UI */\n${common}\n`;
  if (name === 'overview') return prefix + `SELECT kind, measurement_kind, COUNT(*) AS retained_count,
 SUM(local_duration_ms) AS sum_wall_ms, MAX(local_duration_ms) AS max_wall_ms
 FROM observed WHERE kind IS NOT NULL GROUP BY kind, measurement_kind LIMIT 1000;`;
  if (name === 'hotspots') return prefix + `SELECT source_id, build_id, marker_id, name, source_file, source_line, COUNT(*) AS retained_count, SUM(local_duration_ms) AS total_wall_ms,
 CASE WHEN COUNT(observed_self_ms) = COUNT(*) THEN SUM(observed_self_ms) END AS observed_self_ms,
 MAX(local_duration_ms) AS max_wall_ms FROM observed WHERE kind = 'execution'
 GROUP BY source_id, build_id, marker_id, name, source_file, source_line ORDER BY total_wall_ms DESC LIMIT 1000;`;
  if (name === 'operation') {
    if (!key || key.length > 512) throw new Error('operation-key-required');
    return prefix + `SELECT id AS slice_id, ts, dur, name, kind, local_duration_ms, observed_self_ms, measurement_kind, evidence, event_ref, source_id, build_id, source_file, source_line
 FROM observed WHERE operation_key = '${key.replaceAll("'", "''")}' ORDER BY ts, id LIMIT 1000;`;
  }
  if (name === 'queues') return prefix + `SELECT id AS slice_id, correlation_key, local_duration_ms AS wait_ms, evidence
 FROM observed WHERE measurement_kind = 'queue-wait-wall' ORDER BY wait_ms DESC LIMIT 1000;`;
  throw new Error('unknown-query');
}
export function parseCsv(text: string): Record<string, string | number | null>[] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (c === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const header = rows.shift()!;
  return rows.map(values => Object.fromEntries(header.map((h, i) => { const v = values[i] ?? ''; return [h, v === '[NULL]' ? null : /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v) ? Number(v) : v]; })));
}
export async function runAnalysis(directory: string, name: string, processor: string, key?: string) {
  const input = await readCapture(directory), quality = analyzeCapture(input);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const version = (await execute(processor, ['--version'], { timeout: 10000, maxBuffer: 65536 })).stdout.trim();
  if (!version.includes('58.2')) throw new Error(`unsupported-trace-processor:${version}; expected v58.2`);
  const sql = querySql(name, key);
  const results = [];
  for (const trace of manifest.traces) {
    if (!/^traces\/domain-\d+\.pftrace$/.test(trace.path) || !manifest.files[trace.path]) throw new Error('invalid-trace-path');
    // v58.2 emits CSV by default; newer website flags are not available in this binary.
    const result = await execute(processor, ['query', join(directory, trace.path), sql], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    results.push({ trace: trace.path, domain: trace.domain, rows: parseCsv(result.stdout), diagnostics: result.stderr.trim() });
  }
  return { queryVersion: QUERY_VERSION, processorVersion: version, query: name, key, sql,
    quality: { warnings: quality.warnings, missingSources: quality.missingSources, populationStatistics: quality.populationStatistics,
      clockModels: quality.mappings,
      sources: input.sources.map(s => ({ sourceId: s.sourceId, quality: s.quality, environment: s.environment })) },
    relations: name === 'operation' ? quality.relations.filter(r => r.from?.context?.operationKey === key || r.to?.context?.operationKey === key) : undefined,
    results, notes: quality.measurementNotes };
}
