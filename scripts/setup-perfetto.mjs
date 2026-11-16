import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execute = promisify(execFile);

const PLATFORMS = {
  'win32-x64': ['windows-amd64', 'trace_processor_shell.exe', 'adfa6bad3d72be3ba9b83fa2b17b69fa13b3ab1cad0f42e52b86188bd5f0f997'],
  'linux-x64': ['linux-amd64', 'trace_processor_shell', '58042408e6cc861fb1a731c26bb082dc222285561eaa4e12a48a8b2b90dca7b9'],
  'linux-arm64': ['linux-arm64', 'trace_processor_shell', '0e6e0c5452c505c8d46fe472fd196a0d17d963460727e2ce2013b02aa1309555'],
  'linux-arm': ['linux-arm', 'trace_processor_shell', '09683fed93a3452d9dac1f5165a592ec9fec82fba90be2c5dd764c8f9a449e33'],
  'darwin-arm64': ['mac-arm64', 'trace_processor_shell', 'd29864d1ba3b36855527bb1b0ca3aa7f703cdce338b9680bb922c5c151b358fa'],
  'darwin-x64': ['mac-amd64', 'trace_processor_shell', '3927a2767eadd140db3ff4fe0dfbf1bde35c1f56501149cd367f5cee898bef27']
};

const platform = PLATFORMS[`${process.platform}-${process.arch}`];
if (!platform) throw new Error(`Unsupported platform ${process.platform}-${process.arch}. Pass --processor with a verified Perfetto v58.2 binary.`);
const [directory, file, expected] = platform;
const destination = join('.cache', 'perfetto', file);
const url = `https://commondatastorage.googleapis.com/perfetto-luci-artifacts/v58.2/${directory}/${file}`;
const sha = data => createHash('sha256').update(data).digest('hex');

const hasProxyEnv = Boolean(
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy ||
  process.env.ALL_PROXY || process.env.all_proxy
);

async function downloadBytes() {
  // When proxy env vars are configured and NODE_USE_ENV_PROXY is not yet enabled,
  // run fetch in a child Node process with NODE_USE_ENV_PROXY=1 so system proxies work automatically.
  if (hasProxyEnv && process.env.NODE_USE_ENV_PROXY !== '1') {
    try {
      const childScript = `const r = await fetch(${JSON.stringify(url)}); if (!r.ok) throw new Error('HTTP ' + r.status); process.stdout.write(Buffer.from(await r.arrayBuffer()));`;
      const { stdout } = await execute(
        process.execPath,
        ['--input-type=module', '-e', childScript],
        {
          encoding: 'buffer',
          maxBuffer: 64 * 1024 * 1024,
          timeout: 120000,
          env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' }
        }
      );
      return stdout;
    } catch {
      // Fall through to direct fetch / curl fallback below.
    }
  }
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (fetchErr) {
    // Fallback to curl (honors HTTPS_PROXY / ALL_PROXY natively) while still enforcing pinned SHA-256 verification.
    try {
      const { stdout } = await execute('curl', ['-fsSL', url], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
      return stdout;
    } catch {
      throw fetchErr;
    }
  }
}

let bytes;
try { bytes = await readFile(destination); } catch {}
if (!bytes || sha(bytes) !== expected) {
  bytes = await downloadBytes();
  if (sha(bytes) !== expected) throw new Error('Perfetto SHA-256 mismatch');
  await mkdir('.cache/perfetto', { recursive: true });
  await writeFile(destination, bytes);
  if (process.platform !== 'win32') await chmod(destination, 0o755);
}

// Warm up --version immediately after download so macOS first-run checks complete during setup (D4).
let processorVersion = '';
for (let attempt = 0; attempt < 3; attempt++) {
  const out = await execute(destination, ['--version'], { timeout: 30000, maxBuffer: 65536 });
  processorVersion = (out.stdout || out.stderr || '').trim();
  if (processorVersion.includes('58.2')) break;
  await new Promise(r => setTimeout(r, 250));
}
if (!processorVersion.includes('58.2')) {
  throw new Error(`Perfetto binary verification failed (--version output: ${JSON.stringify(processorVersion)})`);
}

console.log(JSON.stringify({ version: 'v58.2', processorVersion, path: destination, sha256: expected }));
