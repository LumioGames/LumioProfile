#!/usr/bin/env node
import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createService } from './service.ts';
import { exportCapture } from './bundle.ts';
import { querySql, runAnalysis } from './query.ts';
import type { AutoCollectorsConfig } from '../../profile/src/types.ts';

export function parseDurationMs(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i.exec(raw.trim());
  if (!m) throw new Error(`invalid-duration:${raw}`);
  const value = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const ms = unit === 'm' ? value * 60_000 : unit === 's' ? value * 1_000 : value;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`invalid-duration:${raw}`);
  return Math.round(ms);
}

export function parseByteSize(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i.exec(raw.trim());
  if (!m) throw new Error(`invalid-bytes:${raw}`);
  const value = Number(m[1]);
  const unit = (m[2] ?? 'b').toLowerCase();
  const mult = unit === 'kb' || unit === 'kib' ? 1024
    : unit === 'mb' || unit === 'mib' ? 1024 * 1024
    : unit === 'gb' || unit === 'gib' ? 1024 * 1024 * 1024
    : 1;
  const bytes = Math.round(value * mult);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`invalid-bytes:${raw}`);
  return bytes;
}

export function parseCollectors(raw?: string): AutoCollectorsConfig | undefined {
  if (!raw) return undefined;
  const cfg: AutoCollectorsConfig = {};
  for (const item of raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
    if (item === 'raf') cfg.raf = true;
    else if (item === 'longtasks' || item === 'longtask') cfg.longTasks = true;
    else if (item === 'loaf' || item === 'long-animation-frame' || item === 'longanimationframes') cfg.longAnimationFrames = true;
    else if (item === 'gc') cfg.gc = true;
    else if (item === 'cpu' || item === 'cpusampling' || item === 'cpu-sampling') cfg.cpuSampling = true;
    else throw new Error(`unknown-collector:${item}`);
  }
  return Object.keys(cfg).length ? cfg : undefined;
}

export function resolveDefaultProcessor(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.LUMIO_TRACE_PROCESSOR) return resolve(process.env.LUMIO_TRACE_PROCESSOR);
  const bin = process.platform === 'win32' ? 'trace_processor_shell.exe' : 'trace_processor_shell';
  const cwdCandidate = resolve('.cache/perfetto', bin);
  if (existsSync(cwdCandidate)) return cwdCandidate;
  const pkgRootCandidate = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.cache/perfetto', bin);
  if (existsSync(pkgRootCandidate)) return pkgRootCandidate;
  const homeCandidate = resolve(homedir(), '.cache/lumio-profile/perfetto', bin);
  if (existsSync(homeCandidate)) return homeCandidate;
  return cwdCandidate;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

async function runCli(rawArgv: string[]) {
  const [command, ...argv] = rawArgv;
  const args = new Map<string, string>();
  const multiArgs = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args.set(name, val);
      const list = multiArgs.get(name) ?? [];
      list.push(val);
      multiArgs.set(name, list);
    } else {
      positional.push(argv[i]);
    }
  }
  const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));

  if (command === 'help' || !command) {
    console.log(`lumio-profile 0.2.0
serve --token-file FILE [--port 9466] [--out artifacts/captures] [--origin URL[,URL]] [--clock-interval 1000ms] [--clock-valid-for 2500ms]
targets|inspect|prepare|start|status|stop|pull|export|release --token-file FILE [--url http://127.0.0.1:9466]
prepare --targets ID,ID --mode trace|stats|hybrid --duration 15s [--bytes 8mb] [--markers 101,102] [--collectors raf,longtasks,loaf,gc,cpu] [--overflow drop-new-detail|overwrite-oldest-chunk] --plan FILE
start --plan FILE --request-id ID
status|stop|pull|export|release --capture ID [--source SOURCE_ID]
convert RAW.json --out NEW_DIRECTORY
analyze DIRECTORY [--query overview|hotspots|percentiles|frames|cpu-hotspots|runtime|queues|operation] [--key KEY] [--sql SQL | --sql-file FILE] [--processor PATH]
sql [--query overview|hotspots|percentiles|frames|cpu-hotspots|runtime|queues|operation] [--key KEY]
All output is JSON except help and sql. No implicit collection or third-party upload.`);
    return;
  }

  if (command === 'sql') {
    console.log(querySql(args.get('query') ?? 'overview', args.get('key')));
    return;
  }

  if (command === 'analyze') {
    const processor = resolveDefaultProcessor(args.get('processor'));
    if (!positional[0]) throw new Error('capture-directory-required');
    const customSql = args.has('sql-file')
      ? await readFile(args.get('sql-file')!, 'utf8')
      : args.get('sql');
    output(await runAnalysis(
      resolve(positional[0]),
      args.get('query') ?? 'overview',
      processor,
      args.get('key'),
      customSql !== undefined ? { customSql } : undefined
    ));
    return;
  }

  if (command === 'convert') {
    if (!positional[0] || !args.get('out')) throw new Error('raw-input-and-output-required');
    output(await exportCapture(JSON.parse(await readFile(positional[0], 'utf8')), args.get('out')!));
    return;
  }

  const tokenFile = args.get('token-file');
  if (!tokenFile) throw new Error('token-file-required');
  let tokenFileWarning: string | undefined;
  if (process.platform !== 'win32') {
    const st = await stat(tokenFile);
    if ((st.mode & 0o077) !== 0) {
      if (args.get('strict-token-file') === 'true') throw new Error('insecure-token-file-permissions:expected-0600');
      tokenFileWarning = 'group-or-world-accessible-recommend-chmod-600';
    }
  }
  const token = (await readFile(tokenFile, 'utf8')).trim();

  if (command === 'serve') {
    const origins = (multiArgs.get('origin') ?? [])
      .flatMap(v => v.split(','))
      .map(v => v.trim())
      .filter(Boolean);
    const service = await createService({
      token,
      port: Number(args.get('port') ?? 9466),
      outputRoot: args.get('out') ?? 'artifacts/captures',
      allowedOrigins: origins,
      requireOrigin: args.get('require-origin') === 'true',
      maxActiveCaptures: args.has('max-captures') ? Number(args.get('max-captures')) : undefined,
      continuousDrain: args.get('no-continuous-drain') === 'true' ? false : true,
      calibration: {
        intervalMs: args.has('clock-interval') ? parseDurationMs(args.get('clock-interval')!) : undefined,
        validForMs: args.has('clock-valid-for') ? parseDurationMs(args.get('clock-valid-for')!) : undefined,
        maxDriftPpm: args.has('clock-drift-ppm') ? Number(args.get('clock-drift-ppm')) : undefined,
        precisionMs: args.has('clock-precision') ? Number(args.get('clock-precision')) : undefined
      }
    });
    output({
      url: service.url,
      targetEndpoint: service.wsUrl,
      status: 'ready',
      ...(tokenFileWarning ? { tokenFilePermissionsWarning: tokenFileWarning } : {})
    });
    process.once('SIGINT', () => { void service.close(); });
    process.once('SIGTERM', () => { void service.close(); });
    return;
  }

  const url = new URL(args.get('url') ?? 'http://127.0.0.1:9466');
  if (!LOOPBACK_HOSTS.has(url.hostname) || url.protocol !== 'http:') throw new Error('v1-control-requires-loopback');
  let params: any = {};
  if (command === 'inspect') params = { sourceId: args.get('source') };
  if (command === 'prepare') {
    const markerIds = args.has('markers')
      ? args.get('markers')!.split(',').map(s => s.trim()).filter(Boolean).map(s => {
          const n = Number(s);
          if (!Number.isInteger(n) || n < 1) throw new Error(`invalid-marker-id:${s}`);
          return n;
        })
      : undefined;
    const collectors = parseCollectors(args.get('collectors'));
    params = {
      targets: (args.get('targets') ?? '').split(',').map(s => s.trim()).filter(Boolean),
      config: {
        mode: args.get('mode') ?? 'trace',
        durationMs: parseDurationMs(args.get('duration') ?? '15000'),
        ...(args.has('bytes') ? { maxBytes: parseByteSize(args.get('bytes')!) } : {}),
        overflowPolicy: args.get('overflow') ?? 'drop-new-detail',
        ...(markerIds?.length ? { markerIds } : {}),
        ...(collectors ? { collectors } : {}),
        ...(args.has('stats-interval') ? { statsIntervalMs: parseDurationMs(args.get('stats-interval')!) } : {})
      }
    };
  }
  if (command === 'start') {
    if (!args.get('plan') || !args.get('request-id')) throw new Error('plan-and-stable-request-id-required');
    const plan = JSON.parse(await readFile(args.get('plan')!, 'utf8'));
    params = { planId: plan.planId, requestId: args.get('request-id') };
  }
  if (['status', 'stop', 'pull', 'export', 'release'].includes(command)) {
    params = { captureId: args.get('capture'), ...(args.has('source') ? { sourceId: args.get('source') } : {}) };
  }
  if (!['targets', 'inspect', 'prepare', 'start', 'status', 'stop', 'pull', 'export', 'release'].includes(command)) {
    throw new Error('unknown-command');
  }
  const response = await fetch(new URL('/api/' + command, url), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(60000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  if (command === 'prepare' && args.get('plan')) await writeFile(args.get('plan')!, JSON.stringify(result, null, 2));
  output(result);
}

const isMain = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (isMain) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
