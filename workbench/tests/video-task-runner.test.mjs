import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectStore } from '../lib/project-store.mjs';
import { createTaskStore } from '../lib/task-store.mjs';
import { createVideoRunner } from '../lib/video-task-runner.mjs';
import { makeTempDir, writeJson } from './helpers.mjs';

test('video task compiles, submits, downloads, and indexes a storyboard segment', async () => {
  const projectsRoot = await makeTempDir('video-task-projects-');
  const repoRoot = await makeTempDir('video-task-repo-');
  const projectStore = createProjectStore({ projectsRoot });
  const project = await projectStore.create({ title: '渡口' });
  await mkdir(join(project.root, 'storyboard', 'E01-01'), { recursive: true });
  await mkdir(join(project.root, 'script'), { recursive: true });
  await writeFile(join(project.root, 'storyboard', 'E01-01', 'f1.png'), 'frame');
  await writeJson(join(project.root, 'storyboard', 'storyboard.json'), {
    source: '渡口',
    episodes: [{ ep: 1, segments: [{ id: 'E01-01', sceneIndex: 1, cuts: [{ beats: [1, 1], seconds: 6, characters: [], props: [], frame: 'wide shot of a ferry' }] }] }],
  });
  await writeJson(join(project.root, 'script', 'script.json'), {
    source: '渡口',
    episodes: [{ ep: 1, scenes: [{ sceneId: 'S01', flow: [{ action: '船在雾中前进。' }] }] }],
  });
  const store = createTaskStore(project.root);
  const task = await store.create({ id: 'task-video', projectId: project.id, type: 'video', provider: 'seedance', options: { provider: 'seedance' } });
  let submitted;
  const runner = createVideoRunner({
    repoRoot,
    projectStore,
    getTaskStore: () => store,
    loadProviderConfigImpl: async () => ({ requestPolicy: {}, promptProfile: {}, referencePolicy: {} }),
    compileSeedanceImpl: () => ({ provider: 'seedance', content: [{ type: 'text', text: 'camera motion' }], apiPayload: { model: 'fixture', content: [{ type: 'text', text: 'camera motion' }] } }),
    submitVideoJobImpl: async ({ input }) => { submitted = input; return { providerTaskId: 'sd-1' }; },
    pollVideoJobImpl: async () => ({ status: 'succeeded', videoUrl: 'https://cdn.example/E01-01.mp4', metadata: { status: 'succeeded' } }),
    downloadVideoImpl: async (_url, destination) => { await writeFile(destination, 'fake-video'); return { path: destination, sha256: 'fixture', size: 10 }; },
    renderAggregateReportImpl: async () => {},
    assetResolver: async (value) => `https://assets.example/${value.slice('asset://'.length)}`,
  });
  const result = await runner(task, { signal: new AbortController().signal });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactIds.includes('video/E01-01-seedance.mp4'), true);
  assert.ok(submitted);
  assert.equal((await readFile(join(project.root, 'video', 'E01-01-seedance.mp4'), 'utf8')), 'fake-video');
  const updated = await store.read(task.id);
  assert.equal(updated.videoJobs[0].segmentId, 'E01-01');
});
