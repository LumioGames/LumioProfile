import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { lstat, rename, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve('.'); await mkdir('artifacts/optional', { recursive: true });
const moved = [];
try {
  for (const name of ['profile', 'profile-tools']) {
    const link = resolve(`node_modules/@lumio/${name}`), hidden = resolve(`node_modules/@lumio/.${name}-unavailable`);
    assert.ok(link.startsWith(root + '\\') || link.startsWith(root + '/'));
    assert.equal((await lstat(link)).isSymbolicLink(), true, 'only move workspace links');
    await rename(link, hidden); moved.push([hidden, link]);
  }
  const require = createRequire(resolve('examples/host/consumer.cjs'));
  assert.throws(() => require.resolve('@lumio/profile'), error => error.code === 'MODULE_NOT_FOUND');
  await writeFile('artifacts/optional/tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, allowImportingTsExtensions: true, types: [] }, files: ['../../examples/host/workload.ts'] }));
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'artifacts/optional/tsconfig.json'], { stdio: 'inherit' });
  const outputs = {};
  for (const enabled of [false, true]) {
    const result = await build({ entryPoints: ['examples/host/workload.ts'], bundle: true, write: false, metafile: true, minify: true, format: 'esm', define: { PROFILE_COMPILED: String(enabled) } });
    const code = result.outputFiles[0].text;
    assert.ok(Object.keys(result.metafile.inputs).every(f => !f.includes('node_modules') && !f.includes('optional-diagnostics')));
    const module = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    assert.equal(module.step(42), 1083814273);
    outputs[enabled ? 'off' : 'stripped'] = { bytes: Buffer.byteLength(code), inputs: Object.keys(result.metafile.inputs) };
    await writeFile(`artifacts/optional/${enabled ? 'off' : 'stripped'}.js`, code);
    if (!enabled) assert.doesNotMatch(code, /trace|event|contract|observation|tick|finally|try/);
  }
  const puerts = await readFile('packages/profile/dist/puerts.cjs', 'utf8');
  assert.doesNotMatch(puerts, /node:|\b(window|document|process)\s*[.\[(]|require\(/);
  const sandbox = { module: { exports: {} } };
  runInNewContext(puerts, sandbox, { timeout: 1000 });
  const host = { contract: 'lumio.observation/1' };
  const profiler = sandbox.module.exports.createPuertsProfiler({ host, role: 'isolated', markers: [{ id: 1, name: 'event', kind: 'event' }],
    build: { id: 'vm', mode: 'debug', codeEpoch: '1' }, nativeBridge: { sourceId: 'vm', clockId: 'native', clockEpoch: '1', nowMs: () => 0, setTimeout: () => 0, clearTimeout: () => {} } });
  const plan = profiler.prepare({ mode: 'trace', durationMs: 100 });
  profiler.start({ token: plan.token, requestId: 'r', captureId: 'c' }); host.trace.event(1); profiler.stop();
  assert.equal(profiler.snapshot().records.length, 1); profiler.release();
  const browser = await readFile('packages/profile/dist/browser.js', 'utf8');
  assert.doesNotMatch(browser, /node:|node_modules|protobufjs|worker_threads/);
  await writeFile('artifacts/optional/results.json', JSON.stringify({ passed: true, physicalPluginResolution: 'unavailable-during-build', outputs, puertsGlobalIsolation: true }, null, 2));
  console.log(JSON.stringify({ passed: true, outputs }));
} finally { for (const [hidden, link] of moved.reverse()) await rename(hidden, link); }
