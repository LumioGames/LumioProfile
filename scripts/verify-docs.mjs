import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

async function collectMarkdown(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...await collectMarkdown(full));
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const files = ['README.md', 'AGENTS.md', 'THIRD_PARTY_NOTICES.md', ...await collectMarkdown('.spec')];
const errors = [];
const linkRe = /\[[^\]]+\]\(([^)#\s]+)(?:#[^)]*)?\)/g;

for (const file of files) {
  const text = await readFile(file, 'utf8');
  if (file.startsWith('.spec/knowledge/') && !file.endsWith('README.md')) {
    if (!text.startsWith('---\n')) errors.push(`${file}: missing YAML frontmatter`);
  }
  let match;
  while ((match = linkRe.exec(text)) !== null) {
    const target = match[1];
    if (/^(https?:|mailto:|conversation:|file:)/.test(target)) continue;
    const resolved = resolve(dirname(file), target);
    try {
      await stat(resolved);
    } catch {
      errors.push(`${file}: broken relative link -> ${target}`);
    }
  }
}

if (errors.length > 0) {
  console.error(JSON.stringify({ passed: false, errors }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ passed: true, checkedFiles: files.length }));
}
