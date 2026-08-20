import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));

export function testFiles() {
  return readdirSync(TEST_ROOT)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => join(TEST_ROOT, name));
}

export function runNodeTests(files = []) {
  const selected = files.length ? files : testFiles();
  const result = spawnSync(process.execPath, ['--test', ...selected], { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runNodeTests(process.argv.slice(2));
}
