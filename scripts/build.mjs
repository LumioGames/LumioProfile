import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(rootDir);

await build({
  absWorkingDir: rootDir,
  entryPoints: ['index', 'browser', 'node', 'puerts'].map(n => `packages/profile/src/${n}.ts`),
  outdir: 'packages/profile/dist',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['node:*'],
  sourcemap: true
});
await build({
  absWorkingDir: rootDir,
  entryPoints: ['packages/profile/src/puerts.ts'],
  outfile: 'packages/profile/dist/puerts.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2020',
  sourcemap: true
});
await build({
  absWorkingDir: rootDir,
  entryPoints: ['index', 'cli'].map(n => `packages/profile-tools/src/${n}.ts`),
  outdir: 'packages/profile-tools/dist',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  sourcemap: true
});
execFileSync(process.execPath, [
  'node_modules/typescript/bin/tsc',
  '--declaration',
  '--emitDeclarationOnly',
  '--outDir', '.cache/declarations',
  '--rootDir', 'packages',
  '--rewriteRelativeImportExtensions', 'true'
], { stdio: 'inherit' });

for (const pkg of ['profile', 'profile-tools']) {
  for (const name of await readdir(`.cache/declarations/${pkg}/src`)) {
    if (!name.endsWith('.d.ts')) continue;
    let content = await readFile(`.cache/declarations/${pkg}/src/${name}`, 'utf8');
    content = content
      .replaceAll('../../profile/src/types.ts', './capture-types.js')
      .replaceAll('.ts\'', '.js\'')
      .replaceAll('.ts"', '.js"');
    await writeFile(`packages/${pkg}/dist/${name}`, content);
  }
}
await writeFile('packages/profile-tools/dist/capture-types.d.ts', await readFile('.cache/declarations/profile/src/types.d.ts'));

// Ship dependency-free host contract inside @lumio/profile (B12).
await copyFile('contracts/observation-v1.d.ts', 'packages/profile/dist/observation-v1.d.ts');

// Build a single-file, zero-relative-import standalone browser declaration file (D6)
// so dev servers redirecting /@lumio/profile/browser to dist/browser.js can copy one file.
const stripLocalImportsAndExports = (src) =>
  src
    .split('\n')
    .filter(line => !/^\s*(import|export)\s+.*from\s+['"]\.\//.test(line))
    .join('\n')
    .replace(/import\(["']\.\/[^"']+["']\)\./g, '')
    .trim();

const typesDts = stripLocalImportsAndExports(await readFile('.cache/declarations/profile/src/types.d.ts', 'utf8'));
const transportDts = stripLocalImportsAndExports(await readFile('.cache/declarations/profile/src/transport.d.ts', 'utf8'));
const coreDts = stripLocalImportsAndExports(await readFile('.cache/declarations/profile/src/core.d.ts', 'utf8'));
const browserDts = stripLocalImportsAndExports(await readFile('.cache/declarations/profile/src/browser.d.ts', 'utf8'));

const standaloneBrowserDts = [
  '/** Self-contained browser entry declarations with zero relative imports (safe to copy for dev-server module redirects). */',
  typesDts,
  transportDts,
  coreDts,
  browserDts,
  ''
].join('\n\n');

assert.ok(!/from\s+['"]|import\(/.test(standaloneBrowserDts), 'standalone browser declaration file must not contain module imports');
await writeFile('packages/profile/dist/browser-standalone.d.ts', standaloneBrowserDts);
await writeFile('contracts/browser-v1.d.ts', standaloneBrowserDts);

console.log('Built isolated runtime entries, standalone browser types, shipped contract, and independent tools.');
