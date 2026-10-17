import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const platform = { 'win32-x64': ['windows-amd64', 'trace_processor_shell.exe', 'adfa6bad3d72be3ba9b83fa2b17b69fa13b3ab1cad0f42e52b86188bd5f0f997'],
  'linux-x64': ['linux-amd64', 'trace_processor_shell', '58042408e6cc861fb1a731c26bb082dc222285561eaa4e12a48a8b2b90dca7b9'],
  'darwin-arm64': ['mac-arm64', 'trace_processor_shell', 'd29864d1ba3b36855527bb1b0ca3aa7f703cdce338b9680bb922c5c151b358fa'] }[`${process.platform}-${process.arch}`];
if (!platform) throw new Error('Use a verified Perfetto v58.2 binary for this platform and pass --processor.');
const [directory, file, expected] = platform;
const destination = join('.cache', 'perfetto', file);
const sha = data => createHash('sha256').update(data).digest('hex');
let bytes;
try { bytes = await readFile(destination); } catch {}
if (!bytes || sha(bytes) !== expected) {
  const response = await fetch(`https://commondatastorage.googleapis.com/perfetto-luci-artifacts/v58.2/${directory}/${file}`);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (sha(bytes) !== expected) throw new Error('Perfetto SHA-256 mismatch');
  await mkdir('.cache/perfetto', { recursive: true }); await writeFile(destination, bytes); await chmod(destination, 0o755);
}
console.log(JSON.stringify({ version: 'v58.2', path: destination, sha256: expected }));
