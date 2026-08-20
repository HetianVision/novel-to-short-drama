import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSkillLock } from '../lib/skill-lock.mjs';
import { createProjectStore } from '../lib/project-store.mjs';
import { createTaskStore } from '../lib/task-store.mjs';
import { createStageRunner, createStageTask } from '../lib/stage-runner.mjs';
import { makeTempDir } from './helpers.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const skillsRoot = join(repoRoot, 'skills');
const fixture = fileURLToPath(new URL('./fixtures/codex-stage-fixture.mjs', import.meta.url));

test('stage task prompt points at the locked Skill and its output contract', () => {
  const task = createStageTask({
    projectId: 'demo-project',
    type: 'outline',
    options: { episodes: '1-3', genre: '悬疑' },
  });
  assert.equal(task.skillName, 'novel-outline');
  assert.equal(task.outputDir, 'outline');
  assert.match(task.prompt, /novel-outline[\\/]SKILL\.md/);
  assert.match(task.prompt, /validate/);
  assert.match(task.prompt, /outline-report\.html/);
  assert.match(task.prompt, /Do not modify.*skills/i);
});

test('storyboard task prompt includes script and original storyboard export steps', () => {
  const task = createStageTask({
    projectId: 'demo-project',
    type: 'storyboard',
    options: { episodes: '1-3' },
  });
  assert.match(task.prompt, /script\.json/);
  assert.match(task.prompt, /novel-storyboard/);
  assert.match(task.prompt, /export/);
  assert.match(task.prompt, /storyboard-report\.html/);
});

test('fake Codex dispatches every text stage into its project output and preserves Skills', async () => {
  const projectsRoot = await makeTempDir('stage-dispatch-projects-');
  const projectStore = createProjectStore({ projectsRoot });
  const project = await projectStore.create({ title: '渡口' });
  const sourceText = await readFile(join(skillsRoot, 'novel-characters', 'examples', '渡口.txt'));
  await projectStore.saveSource(project.id, '渡口.txt', sourceText);
  await chmod(fixture, 0o755);
  const lock = await buildSkillLock({ skillsRoot, sourceCommit: 'fixture-commit' });
  const lockPath = join(project.root, '.workbench', 'skills.lock.json');
  await writeFile(lockPath, `${JSON.stringify(lock)}\n`, 'utf8');
  const store = createTaskStore(project.root);
  const runner = createStageRunner({
    repoRoot,
    skillsRoot,
    skillLockPath: lockPath,
    projectStore,
    getTaskStore: () => store,
    codexBin: fixture,
  });

  const skillBefore = JSON.stringify(lock.skills);
  for (const type of ['outline', 'characters', 'art', 'script', 'storyboard']) {
    const task = {
      ...createStageTask({ projectId: project.id, type, options: { episodes: '1-3' }, projectRoot: project.root }),
      id: `task-${type}`,
      projectId: project.id,
      type,
    };
    await store.create(task);
    const result = await runner(task, { signal: new AbortController().signal });
    assert.equal(result.status, 'succeeded', `${type} should reach succeeded`);
    assert.ok(result.artifactIds.some((path) => path.includes(`${type}/`)));
  }

  const updated = await projectStore.read(project.id);
  for (const type of ['outline', 'characters', 'art', 'script', 'storyboard']) {
    assert.equal(updated.stageState[type].status, 'succeeded');
  }
  assert.equal(JSON.stringify(lock.skills), skillBefore);
});
