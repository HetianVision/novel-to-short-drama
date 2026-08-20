import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function makeTempDir(prefix = 'short-drama-workbench-') {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function assertFileMissing(path) {
  await assert.rejects(stat(path), { code: 'ENOENT' });
}
