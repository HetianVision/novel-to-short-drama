import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';
import { makeTempDir } from './helpers.mjs';
import { createProjectStore } from '../lib/project-store.mjs';
import { createTaskStore } from '../lib/task-store.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson } from './helpers.mjs';

async function withServer(t) {
  const projectsRoot = await makeTempDir('http-api-projects-');
  const projectStore = createProjectStore({ projectsRoot });
  const taskQueue = {
    enqueue: () => new Promise(() => {}),
    cancel: () => true,
  };
  const server = createServer({ projectStore, taskQueue, repoRoot: process.cwd() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => server.close());
  return { base, projectStore };
}

async function postJson(base, path, value) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  return { response, body: await response.json() };
}

test('creates project and uploads raw source', async (t) => {
  const { base } = await withServer(t);
  const created = await postJson(base, '/api/projects', { title: '渡口' });
  assert.equal(created.response.status, 201);
  const source = await fetch(`${base}/api/projects/${created.body.id}/sources?filename=novel.txt`, {
    method: 'POST', body: '小说正文', headers: { 'content-type': 'text/plain' },
  });
  assert.equal(source.status, 201);
  assert.equal((await source.json()).relativePath, 'source/novel.txt');
});

test('blocks storyboard before script exists', async (t) => {
  const { base } = await withServer(t);
  const created = await postJson(base, '/api/projects', { title: '渡口' });
  const response = await postJson(base, `/api/projects/${created.body.id}/tasks`, { type: 'storyboard', options: {} });
  assert.equal(response.response.status, 409);
  assert.deepEqual(response.body.missing, ['script.json']);
});

test('artifact route rejects traversal', async (t) => {
  const { base } = await withServer(t);
  const created = await postJson(base, '/api/projects', { title: '渡口' });
  const response = await fetch(`${base}/api/projects/${created.body.id}/artifacts/..%2F..%2Fpackage.json`);
  assert.equal(response.status, 400);
});

test('SSE emits stored task events', async (t) => {
  const { base, projectStore } = await withServer(t);
  const created = await postJson(base, '/api/projects', { title: '渡口' });
  await fetch(`${base}/api/projects/${created.body.id}/sources?filename=novel.txt`, { method: 'POST', body: '小说正文' });
  const task = await postJson(base, `/api/projects/${created.body.id}/tasks`, { type: 'outline', options: {} });
  const project = await projectStore.read(created.body.id);
  const store = createTaskStore(project.root);
  await store.appendEvent(task.body.id, { type: 'task.started', status: 'running' });

  const response = await fetch(`${base}/api/tasks/${task.body.id}/events`);
  const reader = response.body.getReader();
  const first = await reader.read();
  await reader.cancel();
  const text = new TextDecoder().decode(first.value);
  assert.match(text, /task\.started/);
});

test('health route reports local server and Codex state', async (t) => {
  const { base } = await withServer(t);
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.codex.available, 'boolean');
});

test('creates a video job through the provider route after storyboard images exist', async (t) => {
  const { base, projectStore } = await withServer(t);
  const created = await postJson(base, '/api/projects', { title: '渡口视频' });
  const project = await projectStore.read(created.body.id);
  await mkdir(join(project.root, 'storyboard', 'E01-01'), { recursive: true });
  await mkdir(join(project.root, 'script'), { recursive: true });
  await writeFile(join(project.root, 'storyboard', 'E01-01', 'f1.png'), 'frame');
  await writeJson(join(project.root, 'storyboard', 'storyboard.json'), { episodes: [{ ep: 1, segments: [{ id: 'E01-01', cuts: [{ seconds: 6 }] }] }] });
  await writeJson(join(project.root, 'script', 'script.json'), { episodes: [{ ep: 1, scenes: [] }] });
  const response = await postJson(base, `/api/projects/${created.body.id}/video-jobs`, { provider: 'seedance', options: {} });
  assert.equal(response.response.status, 202);
  assert.equal(response.body.type, 'video');
  assert.equal(response.body.provider, 'seedance');
});
