import { performance, PerformanceObserver } from 'node:perf_hooks';
import { cpus, totalmem, platform, release } from 'node:os';
import { mkdir, writeFile, readFile, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { createHarness } from './bench/harness.mjs';
import { summarize } from './bench/statistics.mjs';

const args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1]; };
const runtime = option('runtime', 'node'), kind = option('kind', 'paced');
if (!['node', 'browser'].includes(runtime) || !['paced', 'throughput', 'cpu-window'].includes(kind) || (runtime === 'browser' && kind === 'cpu-window')) throw new Error('invalid-runtime-or-kind');
const rounds = Number(option('rounds', kind === 'paced' ? 2000 : kind === 'cpu-window' ? 32 : 64));
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10000) throw new Error('invalid-rounds');
const tag = option('tag', 'measurement');
if (!/^[a-z0-9-]{1,64}$/.test(tag)) throw new Error('invalid-tag');
await mkdir('.cache', { recursive: true });
const lock = await open('.cache/benchmark.lock', 'wx');
await lock.writeFile(String(process.pid));
let cleanup = async () => {};
const gc = [];
const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) gc.push({ startTime: e.startTime, duration: e.duration, kind: e.detail.kind }); });
try {
  const sourceFiles = ['packages/profile/src/core.ts', 'packages/profile/src/node.ts', 'packages/profile/src/browser.ts',
    'packages/profile/dist/node.js', 'packages/profile/dist/browser.js', 'scripts/benchmark.mjs',
    'scripts/bench/harness.mjs', 'scripts/bench/workload.mjs', 'scripts/bench/statistics.mjs'];
  const hashes = {}, sources = new Map();
  for (const file of sourceFiles) {
    const bytes = await readFile(file); sources.set(file, bytes);
    hashes[file] = createHash('sha256').update(bytes).digest('hex');
  }
  const path = `artifacts/benchmark/v2/${new Date().toISOString().replaceAll(':', '-')}-${runtime}-${kind}-${tag}`;
  await mkdir(path, { recursive: true });
  const progress = p => console.log(JSON.stringify({ runtime, ...p }));
  let raw, environment;
  if (runtime === 'node') {
    const { createNodeProfiler } = await import('../packages/profile/dist/node.js');
    observer.observe({ entryTypes: ['gc'] });
    const memoryBefore = process.memoryUsage();
    raw = await createHarness(createNodeProfiler, { now: () => performance.now(),
      cpu: previous => { if (!previous) return process.cpuUsage(); const c = process.cpuUsage(previous); return (c.user + c.system) / 1000; },
      sleep: ms => new Promise(r => setTimeout(r, ms)), yield: () => new Promise(r => setImmediate(r)), progress }).run({ kind, rounds });
    await new Promise(r => setImmediate(r));
    environment = { node: process.version, execArgv: process.execArgv, memoryBefore, memoryAfter: process.memoryUsage(), gc,
      clockResolutionMs: resolution(() => performance.now()), cpuScope: 'whole Node process; includes GC/runtime background work; CPU precision inferred from A/A control' };
  } else {
    const { chromium } = await import('playwright');
    const { build } = await import('esbuild');
    const bundle = await build({ stdin: { contents: "export {createHarness} from './scripts/bench/harness.mjs'; export {createBrowserProfiler} from './packages/profile/src/browser.ts';", resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'browser', write: false });
    const http = createServer((req, res) => {
      if (req.url === '/bench.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].text); }
      else { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Lumio performance benchmark</title><p>Independent synthetic benchmark</p>'); }
    });
    await new Promise(r => http.listen(0, '127.0.0.1', r));
    let browser;
    cleanup = async () => { await browser?.close(); await new Promise(r => http.close(r)); };
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-automation'],
      ignoreDefaultArgs: ['--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const session = await browser.newBrowserCDPSession();
    const commandLine = (await session.send('Browser.getBrowserCommandLine')).arguments;
    const page = await browser.newPage();
    await page.exposeFunction('reportProgress', progress);
    await page.goto(`http://127.0.0.1:${http.address().port}`);
    const output = await page.evaluate(async ({ kind, rounds }) => {
      const { createHarness, createBrowserProfiler } = await import('/bench.js');
      let resolutionMs = Infinity, last = performance.now();
      for (let i = 0; i < 100000; i++) { const now = performance.now(); if (now > last) resolutionMs = Math.min(resolutionMs, now - last); last = now; }
      const raw = await createHarness(createBrowserProfiler, { now: () => performance.now(),
        sleep: ms => new Promise(r => setTimeout(r, ms)), yield: () => new Promise(r => setTimeout(r, 0)),
        visibility: () => document.visibilityState, progress: p => void window.reportProgress(p) }).run({ kind, rounds });
      return { raw, resolutionMs, visibility: document.visibilityState, crossOriginIsolated };
    }, { kind, rounds });
    raw = output.raw;
    environment = { browser: browser.version(), headless: true, realOsForegroundValidated: false, commandLine,
      visibility: output.visibility, crossOriginIsolated: output.crossOriginIsolated, clockResolutionMs: output.resolutionMs,
      cpuScope: 'not measured: JavaScript wall duration is not CPU time', gc: 'not measured' };
    await writeFile(`${path}/browser-bundle.js`, bundle.outputFiles[0].text);
  }
  Object.assign(raw, { runtime, environment, hashes, collectedAt: new Date().toISOString(),
    machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memory: totalmem() } });
  const summaries = summarize(raw);
  await writeFile(`${path}/raw.json`, JSON.stringify(raw, null, 2));
  await writeFile(`${path}/summary.json`, JSON.stringify({ runtime, kind, rounds, environment, hashes, summaries }, null, 2));
  for (const file of sourceFiles) await writeFile(`${path}/${file.replaceAll('/', '_')}`, sources.get(file));
  console.log(JSON.stringify({ path: resolve(path), summaries }));
} finally {
  observer.disconnect();
  try { await cleanup(); } finally { await lock.close(); await unlink('.cache/benchmark.lock'); }
}
function resolution(now) {
  let previous = now(), result = Infinity;
  for (let i = 0; i < 100000; i++) { const t = now(); if (t > previous) result = Math.min(result, t - previous); previous = t; }
  return result;
}
