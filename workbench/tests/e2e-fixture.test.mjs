import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashSkillDirectory } from '../lib/skill-lock.mjs';
import { indexArtifacts } from '../lib/artifact-index.mjs';
import { createProjectStore } from '../lib/project-store.mjs';
import { createTaskStore } from '../lib/task-store.mjs';
import { createStageRunner, createStageTask } from '../lib/stage-runner.mjs';
import { makeTempDir } from './helpers.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const skillsRoot = join(repoRoot, 'skills');
const codexFixture = fileURLToPath(new URL('./fixtures/codex-fixture.mjs', import.meta.url));

async function skillHashes() {
  const names = ['novel-art', 'novel-characters', 'novel-outline', 'novel-script', 'novel-storyboard', 'shot-recipes'];
  const result = {};
  for (const name of names) result[name] = (await hashSkillDirectory(join(skillsRoot, name))).sha256;
  return result;
}

test('fixture project completes all original text stages and leaves Skill hashes unchanged', async () => {
  await chmod(codexFixture, 0o755);
  const projectsRoot = await makeTempDir('e2e-fixture-projects-');
  const projectStore = createProjectStore({ projectsRoot });
  const project = await projectStore.create({ title: '渡口夹具' });
  await projectStore.saveSource(project.id, '渡口.txt', await readFile(join(skillsRoot, 'novel-characters', 'examples', '渡口.txt')));
  const initial = await skillHashes();
  const store = createTaskStore(project.root);
  const runner = createStageRunner({
    repoRoot,
    skillsRoot,
    skillLockPath: join(repoRoot, 'skills.lock.json'),
    projectStore,
    getTaskStore: () => store,
    codexBin: codexFixture,
  });

  for (const type of ['outline', 'characters', 'art', 'script', 'storyboard']) {
    const task = await store.create({
      ...createStageTask({ projectId: project.id, type, options: { episodes: '1-3' }, projectRoot: project.root }),
      id: `fixture-${type}`,
      projectId: project.id,
      type,
      status: 'queued',
    });
    const result = await runner(task, { signal: new AbortController().signal });
    assert.equal(result.status, 'succeeded', `${type} should succeed`);
  }

  const artifacts = await indexArtifacts(project.root);
  for (const type of ['outline', 'characters', 'art', 'script', 'storyboard']) {
    assert.ok(artifacts.some((artifact) => artifact.relativePath.startsWith(`${type}/`) && artifact.type === 'json'), `${type} JSON should be indexed`);
  }
  assert.ok(artifacts.some((artifact) => artifact.relativePath === '.workbench/report.html'));
  assert.deepEqual(await skillHashes(), initial);
});
