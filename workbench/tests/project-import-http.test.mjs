import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from '../server.mjs';
import { makeTempDir } from './helpers.mjs';
import { createProjectStore } from '../lib/project-store.mjs';

async function fixtureFile(root, relativePath, content) {
  const destination = join(root, relativePath);
  await mkdir(join(destination, '..'), { recursive: true });
  await writeFile(destination, content);
}

test('imports the local skill-test snapshot through the workbench API', async (t) => {
  const sourceRoot = await makeTempDir('skill-test-http-fixture-');
  const projectsRoot = await makeTempDir('skill-test-http-projects-');
  await fixtureFile(sourceRoot, 'input/小说.txt', '正文');
  for (const stage of ['outline', 'characters', 'art', 'script', 'storyboard']) {
    await fixtureFile(sourceRoot, `${stage}/${stage}.json`, '{}');
    await fixtureFile(sourceRoot, `${stage}/${stage}-report.html`, `<main>${stage}</main>`);
  }
  await fixtureFile(sourceRoot, 'docs/outline-report.html', '<main>outline-doc</main>');
  await fixtureFile(sourceRoot, 'docs/outline-report.md', '# outline');
  await fixtureFile(sourceRoot, 'docs/outline-assets.json', '{}');

  const projectStore = createProjectStore({ projectsRoot });
  const server = createServer({ projectStore, repoRoot: process.cwd(), skillTestRoot: sourceRoot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${base}/api/projects/import-skill-test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'yidi-jimao', title: '一地鸡毛' }),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.title, '一地鸡毛');
  assert.equal(body.stageState.storyboard.status, 'succeeded');

  const report = await fetch(`${base}/api/projects/yidi-jimao/artifacts/outline%2Foutline-report.html`);
  assert.equal(report.status, 200);
  assert.match(await report.text(), /outline-doc/);
});
