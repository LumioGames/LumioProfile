import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

await mkdir('artifacts/optional', { recursive: true });

// Verify absence-of-plugin build in an isolated temp directory outside the repo tree so
// workspace node_modules is never mutated (safe even if interrupted by SIGKILL/SIGINT).
const isolatedRoot = await mkdtemp(join(tmpdir(), 'lumio-profile-optional-'));
try {
  await mkdir(join(isolatedRoot, 'contracts'), { recursive: true });
  await mkdir(join(isolatedRoot, 'examples', 'host'), { recursive: true });
  await copyFile('contracts/observation-v1.d.ts', join(isolatedRoot, 'contracts', 'observation-v1.d.ts'));
  await copyFile('examples/host/observation.ts', join(isolatedRoot, 'examples', 'host', 'observation.ts'));
  await copyFile('examples/host/workload.ts', join(isolatedRoot, 'examples', 'host', 'workload.ts'));

  const isolatedRequire = createRequire(join(isolatedRoot, 'examples', 'host', 'consumer.cjs'));
  assert.throws(() => isolatedRequire.resolve('@lumio/profile'), (error) => error.code === 'MODULE_NOT_FOUND');
  assert.throws(() => isolatedRequire.resolve('@lumio/profile-tools'), (error) => error.code === 'MODULE_NOT_FOUND');

  const tsconfigPath = join(isolatedRoot, 'tsconfig.json');
  await writeFile(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      types: []
    },
    files: ['./examples/host/workload.ts']
  }));
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', tsconfigPath], { stdio: 'inherit' });

  const outputs = {};
  for (const enabled of [false, true]) {
    const result = await build({
      absWorkingDir: isolatedRoot,
      entryPoints: ['examples/host/workload.ts'],
      bundle: true,
      write: false,
      metafile: true,
      minify: true,
      format: 'esm',
      define: { PROFILE_COMPILED: String(enabled) }
    });
    const code = result.outputFiles[0].text;
    assert.ok(Object.keys(result.metafile.inputs).every(f => !f.includes('node_modules') && !f.includes('optional-diagnostics')));
    const module = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    assert.equal(module.step(42), 1083814273);
    outputs[enabled ? 'off' : 'stripped'] = { bytes: Buffer.byteLength(code), inputs: Object.keys(result.metafile.inputs) };
    await writeFile(`artifacts/optional/${enabled ? 'off' : 'stripped'}.js`, code);
    if (!enabled) assert.doesNotMatch(code, /trace|event|contract|observation|tick|finally|try/);
  }

  // Also verify standalone single-file browser declaration typechecks with zero @lumio/* resolution.
  await copyFile('contracts/browser-v1.d.ts', join(isolatedRoot, 'contracts', 'browser-v1.d.ts'));
  await writeFile(join(isolatedRoot, 'standalone-consumer.ts'), `
    import type { BrowserOptions, ProfileHost } from './contracts/browser-v1.d.ts';
    const host: ProfileHost = { contract: 'lumio.observation/1' };
    export const opts: BrowserOptions = { host, role: 'client-main', markers: [], build: { id: 'dev', mode: 'debug', codeEpoch: '1' } };
  `);
  await writeFile(join(isolatedRoot, 'tsconfig.standalone.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, allowImportingTsExtensions: true, types: [] },
    files: ['./standalone-consumer.ts']
  }));
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(isolatedRoot, 'tsconfig.standalone.json')], { stdio: 'inherit' });

  const puerts = await readFile('packages/profile/dist/puerts.cjs', 'utf8');
  assert.doesNotMatch(puerts, /node:|\b(window|document|process)\s*[.\[(]|require\(/);
  const sandbox = { module: { exports: {} } };
  runInNewContext(puerts, sandbox, { timeout: 1000 });
  const host = { contract: 'lumio.observation/1' };
  const profiler = sandbox.module.exports.createPuertsProfiler({
    host,
    role: 'isolated',
    markers: [{ id: 1, name: 'event', kind: 'event' }],
    build: { id: 'vm', mode: 'debug', codeEpoch: '1' },
    nativeBridge: { sourceId: 'vm', clockId: 'native', clockEpoch: '1', nowMs: () => 0, setTimeout: () => 0, clearTimeout: () => {} }
  });
  const plan = profiler.prepare({ mode: 'trace', durationMs: 100 });
  profiler.start({ token: plan.token, requestId: 'r', captureId: 'c' });
  host.trace.event(1);
  profiler.stop();
  assert.equal(profiler.snapshot().records.length, 1);
  profiler.release();

  const browser = await readFile('packages/profile/dist/browser.js', 'utf8');
  assert.doesNotMatch(browser, /node:|node_modules|protobufjs|worker_threads/);
  await writeFile('artifacts/optional/results.json', JSON.stringify({
    passed: true,
    physicalPluginResolution: 'isolated-outside-workspace-tree',
    standaloneBrowserTypesVerified: true,
    outputs,
    puertsGlobalIsolation: true
  }, null, 2));
  console.log(JSON.stringify({ passed: true, outputs }));
} finally {
  await rm(isolatedRoot, { recursive: true, force: true });
}
