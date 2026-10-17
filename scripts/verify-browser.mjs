import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createService } from '../packages/profile-tools/src/service.ts';
import { readCapture } from '../packages/profile-tools/src/bundle.ts';
import { runAnalysis } from '../packages/profile-tools/src/query.ts';
const files = { '/sdk.js': 'packages/profile/dist/browser.js', '/main.js': 'examples/browser/main.js', '/worker.js': 'examples/browser/worker.js' };
const http = createServer(async (req, res) => {
  const file = files[req.url];
  if (file) { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(file)); }
  else if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Lumio Profile validation host</title><p>Independent synthetic host. No game code.</p><script type="module" src="/main.js"></script>'); }
  else { res.writeHead(404); res.end(); }
});
await new Promise(r => http.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${http.address().port}`;
const token = randomUUID();
const service = await createService({ port: 0, token, outputRoot: 'artifacts/browser', allowedOrigins: [origin] });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-automation'],
  ignoreDefaultArgs: ['--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
try {
  const session = await browser.newBrowserCDPSession();
  const command = await session.send('Browser.getBrowserCommandLine');
  for (const flag of ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']) assert.ok(!command.arguments.includes(flag));
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const page = await browser.newPage(); await page.goto(origin);
    await page.waitForFunction(() => typeof window.startProfile === 'function');
    assert.equal((await page.evaluate(() => window.profileStatus())).allocatedBytes, 0);
    await page.evaluate(config => window.startProfile(config), { endpoint: service.wsUrl, token }); pages.push(page);
  }
  const deadline = Date.now() + 5000;
  while ((await service.call('targets')).length < 4 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  const targets = await service.call('targets'); assert.equal(targets.length, 4);
  const plan = await service.call('prepare', { targets: targets.map(t => t.sourceId), config: { mode: 'trace', durationMs: 3000 } });
  const capture = await service.call('start', { planId: plan.planId, requestId: 'browser-' + randomUUID() });
  await new Promise(r => setTimeout(r, 1100));
  await service.call('stop', capture); const exported = await service.call('export', capture);
  const raw = await readCapture(exported.path); assert.equal(raw.sources.length, 4);
  assert.ok(raw.sources.every(s => s.records.length > 0));
  const processor = resolve('.cache/perfetto', process.platform === 'win32' ? 'trace_processor_shell.exe' : 'trace_processor_shell');
  const analysis = await runAnalysis(exported.path, 'hotspots', processor);
  assert.ok(analysis.results.some(r => r.rows.length > 0));
  const visibility = await Promise.all(pages.map(p => p.evaluate(() => document.visibilityState)));
  const report = { passed: true, version: browser.version(), headless: true, windows: 1, pages: 2, realOsForegroundValidated: false,
    visibility, commandLine: command.arguments, sources: raw.sources.map(s => ({ role: s.role, sourceId: s.sourceId, records: s.records.length, quality: s.quality })), capture: exported.path, analysis };
  await writeFile('artifacts/browser/verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, headless: true, realOsForegroundValidated: false, pages: 2, sources: 4, capture: exported.path }));
} finally { await browser.close(); await service.close(); await new Promise(r => http.close(r)); }
