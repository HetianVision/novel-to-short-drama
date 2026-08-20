import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from './helpers.mjs';
import { assertExpectedArtifacts, indexArtifacts } from '../lib/artifact-index.mjs';

test('artifact index classifies report, image, and JSON', async () => {
  const projectRoot = await makeTempDir('artifact-index-');
  await mkdir(join(projectRoot, 'outline'), { recursive: true });
  await writeFile(join(projectRoot, 'outline', 'outline.json'), '{}\n');
  await writeFile(join(projectRoot, 'outline', 'outline-report.html'), '<html></html>\n');
  await writeFile(join(projectRoot, 'outline', 'cover.png'), Buffer.from([137, 80, 78, 71]));
  const artifacts = await indexArtifacts(projectRoot);
  assert.deepEqual(new Set(artifacts.map((artifact) => artifact.type)), new Set(['json', 'report', 'image']));
  assert.ok(artifacts.every((artifact) => typeof artifact.sha256 === 'string'));
});

test('artifact contract names missing stage JSON', async () => {
  const projectRoot = await makeTempDir('artifact-index-');
  const artifacts = await indexArtifacts(projectRoot);
  assert.throws(() => assertExpectedArtifacts('outline', artifacts), /outline|artifact/i);
});
