#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createService } from './service.ts';
import { exportCapture } from './bundle.ts';
import { querySql, runAnalysis } from './query.ts';

const [command, ...argv] = process.argv.slice(2);
const args = new Map<string, string>(); const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const name = argv[i].slice(2); args.set(name, argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'); }
  else positional.push(argv[i]);
}
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function run() {
  if (command === 'help' || !command) {
    console.log(`lumio-profile 0.1.0
serve --token-file FILE [--port 9466] [--out artifacts/captures] [--origin http://localhost:PORT]
targets|inspect|prepare|start|status|stop|export --token-file FILE [--url http://127.0.0.1:9466]
prepare --targets ID,ID --mode trace|stats --duration 15000 [--bytes 8388608] [--overflow drop-new-detail|overwrite-oldest-chunk] --plan FILE
start --plan FILE --request-id ID
status|stop|export --capture ID
convert RAW.json --out NEW_DIRECTORY
analyze DIRECTORY --query overview|hotspots|queues|operation [--key KEY] [--processor PATH]
sql --query overview|hotspots|queues|operation [--key KEY]
All output is JSON except help and sql. No implicit collection or third-party upload.`); return;
  }
  if (command === 'sql') { console.log(querySql(args.get('query') ?? 'overview', args.get('key'))); return; }
  if (command === 'analyze') {
    const processor = args.get('processor') ?? process.env.LUMIO_TRACE_PROCESSOR ?? resolve('.cache/perfetto', process.platform === 'win32' ? 'trace_processor_shell.exe' : 'trace_processor_shell');
    if (!positional[0]) throw new Error('capture-directory-required');
    output(await runAnalysis(resolve(positional[0]), args.get('query') ?? 'overview', processor, args.get('key'))); return;
  }
  if (command === 'convert') {
    if (!positional[0] || !args.get('out')) throw new Error('raw-input-and-output-required');
    output(await exportCapture(JSON.parse(await readFile(positional[0], 'utf8')), args.get('out')!)); return;
  }
  const tokenFile = args.get('token-file'); if (!tokenFile) throw new Error('token-file-required');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (command === 'serve') {
    const service = await createService({ token, port: Number(args.get('port') ?? 9466), outputRoot: args.get('out') ?? 'artifacts/captures', allowedOrigins: args.has('origin') ? [args.get('origin')!] : [] });
    output({ url: service.url, targetEndpoint: service.wsUrl, status: 'ready' });
    process.once('SIGINT', () => { void service.close(); }); process.once('SIGTERM', () => { void service.close(); }); return;
  }
  const url = new URL(args.get('url') ?? 'http://127.0.0.1:9466');
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('v1-control-requires-loopback');
  let params: any = {};
  if (command === 'inspect') params = { sourceId: args.get('source') };
  if (command === 'prepare') params = { targets: (args.get('targets') ?? '').split(',').filter(Boolean), config: {
    mode: args.get('mode') ?? 'trace', durationMs: Number(args.get('duration') ?? 15000), maxBytes: Number(args.get('bytes') ?? 8 * 1024 * 1024), overflowPolicy: args.get('overflow') ?? 'drop-new-detail' } };
  if (command === 'start') {
    if (!args.get('plan') || !args.get('request-id')) throw new Error('plan-and-stable-request-id-required');
    const plan = JSON.parse(await readFile(args.get('plan')!, 'utf8')); params = { planId: plan.planId, requestId: args.get('request-id') };
  }
  if (['status', 'stop', 'export'].includes(command)) params = { captureId: args.get('capture') };
  if (!['targets', 'inspect', 'prepare', 'start', 'status', 'stop', 'export'].includes(command)) throw new Error('unknown-command');
  const response = await fetch(new URL('/api/' + command, url), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  if (command === 'prepare' && args.get('plan')) await writeFile(args.get('plan')!, JSON.stringify(result, null, 2));
  output(result);
}
run().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
