import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
await build({ entryPoints: ['index', 'browser', 'node', 'puerts'].map(n => `packages/profile/src/${n}.ts`), outdir: 'packages/profile/dist', bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], sourcemap: true });
await build({ entryPoints: ['packages/profile/src/puerts.ts'], outfile: 'packages/profile/dist/puerts.cjs', bundle: true, format: 'cjs', platform: 'neutral', target: 'es2020', sourcemap: true });
await build({ entryPoints: ['index', 'cli'].map(n => `packages/profile-tools/src/${n}.ts`), outdir: 'packages/profile-tools/dist', bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', sourcemap: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--declaration', '--emitDeclarationOnly', '--outDir', '.cache/declarations', '--rootDir', 'packages', '--rewriteRelativeImportExtensions', 'true'], { stdio: 'inherit' });
for (const pkg of ['profile', 'profile-tools']) {
  for (const name of await readdir(`.cache/declarations/${pkg}/src`)) if (name.endsWith('.d.ts')) {
    let content = await readFile(`.cache/declarations/${pkg}/src/${name}`, 'utf8');
    content = content.replaceAll('../../profile/src/types.ts', './capture-types.js').replaceAll('.ts\'', '.js\'').replaceAll('.ts"', '.js"');
    await writeFile(`packages/${pkg}/dist/${name}`, content);
  }
}
await writeFile('packages/profile-tools/dist/capture-types.d.ts', await readFile('.cache/declarations/profile/src/types.d.ts'));
console.log('Built isolated runtime entries and independent tools.');
