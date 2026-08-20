import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir, readJson } from './helpers.mjs';
import { createProjectStore } from '../lib/project-store.mjs';

test('creates a project with the original workflow output directories', async () => {
  const projectsRoot = await makeTempDir('project-store-');
  const store = createProjectStore({ projectsRoot, now: () => '2026-08-21T00:00:00.000Z' });
  const project = await store.create({ id: 'demo-project', title: '渡口' });

  assert.equal(project.id, 'demo-project');
  assert.equal(project.title, '渡口');
  for (const dir of ['source', 'outline', 'characters', 'art', 'script', 'storyboard', 'video', '.workbench']) {
    await assert.doesNotReject(stat(join(project.root, dir)));
  }
  assert.deepEqual((await readJson(join(project.root, '.workbench', 'project.json'))).stageState, {});
});

test('source upload stays inside project source directory and records a hash', async () => {
  const projectsRoot = await makeTempDir('project-store-');
  const store = createProjectStore({ projectsRoot, now: () => '2026-08-21T00:00:00.000Z' });
  await store.create({ id: 'demo-project', title: '渡口' });

  const result = await store.saveSource('demo-project', 'novel.txt', Buffer.from('渡口'));
  assert.match(result.path, /demo-project[\\/]source[\\/]novel\.txt$/);
  assert.equal(result.relativePath, 'source/novel.txt');
  assert.equal(await readFile(result.path, 'utf8'), '渡口');
  assert.equal(result.sha256, 'a43bb3032007d2b2c544ebe7981a7a7a98a57b6adaa27b19eb7d328375fd6474');

  const project = await store.read('demo-project');
  assert.deepEqual(project.sources, [{
    filename: 'novel.txt',
    relativePath: 'source/novel.txt',
    size: Buffer.byteLength('渡口'),
    sha256: result.sha256,
    updatedAt: '2026-08-21T00:00:00.000Z'
  }]);
});

test('source upload refuses nested traversal', async () => {
  const projectsRoot = await makeTempDir('project-store-');
  const store = createProjectStore({ projectsRoot });
  await store.create({ id: 'demo-project', title: '渡口' });
  await assert.rejects(store.saveSource('demo-project', '../outside.txt', Buffer.from('x')), /path/i);
});
