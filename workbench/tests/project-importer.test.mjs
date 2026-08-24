import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir, readJson } from './helpers.mjs';
import { createProjectStore } from '../lib/project-store.mjs';
import { createTaskStore } from '../lib/task-store.mjs';
import { importSkillTestProject } from '../lib/project-importer.mjs';

async function writeFixture(root, relativePath, content) {
  const destination = join(root, relativePath);
  await mkdir(join(destination, '..'), { recursive: true });
  await writeFile(destination, content);
}

test('imports skill-test outputs into an independent completed workbench project', async () => {
  const sourceRoot = await makeTempDir('skill-test-fixture-');
  const projectsRoot = await makeTempDir('skill-test-projects-');
  await writeFixture(sourceRoot, 'input/小说.txt', '小说正文');
  await writeFixture(sourceRoot, 'outline/一地鸡毛-outline.json', '{"episodes":[]}');
  await writeFixture(sourceRoot, 'docs/outline-report.html', '<img src="outline.png">');
  await writeFixture(sourceRoot, 'docs/outline-report.md', '# 大纲');
  await writeFixture(sourceRoot, 'docs/outline-assets.json', '{}');
  await writeFixture(sourceRoot, 'characters/一地鸡毛-cast.json', '{"characters":[]}');
  await writeFixture(sourceRoot, 'characters/一地鸡毛-cast-report.html', '<img src="images/小林-sheet.png">');
  await writeFixture(sourceRoot, 'characters/images/小林-sheet.png', 'character');
  await writeFixture(sourceRoot, 'art/一地鸡毛-art.json', '{"scenes":[]}');
  await writeFixture(sourceRoot, 'art/一地鸡毛-art-report.html', '<img src="images/客厅-sheet.png">');
  await writeFixture(sourceRoot, 'art/images/客厅-sheet.png', 'art');
  await writeFixture(sourceRoot, 'script/一地鸡毛-script.json', '{"episodes":[]}');
  await writeFixture(sourceRoot, 'script/一地鸡毛-script-report.html', '<main>script</main>');
  await writeFixture(sourceRoot, 'storyboard/一地鸡毛-storyboard.json', '{"episodes":[]}');
  await writeFixture(sourceRoot, 'storyboard/manifest.json', '[]');
  await writeFixture(sourceRoot, 'storyboard/一地鸡毛-storyboard-report.html', '<img src="E01-01/f1.png">');
  await writeFixture(sourceRoot, 'storyboard/E01-01/f1.png', 'frame');
  await writeFixture(sourceRoot, 'logs/build-storyboard.mjs', 'not a deliverable');
  await writeFixture(sourceRoot, '.gates.jsonl', '{"ok":true}');

  const projectStore = createProjectStore({ projectsRoot, now: () => '2026-08-24T00:00:00.000Z' });
  const project = await importSkillTestProject({
    sourceRoot,
    projectStore,
    projectId: 'yidi-jimao',
    title: '一地鸡毛',
    taskStoreFactory: (root) => createTaskStore(root, { now: () => '2026-08-24T00:00:00.000Z' }),
  });

  assert.equal(project.id, 'yidi-jimao');
  assert.equal(project.title, '一地鸡毛');
  assert.deepEqual(project.sources.map((source) => source.relativePath), ['source/小说.txt']);
  for (const stage of ['outline', 'characters', 'art', 'script', 'storyboard']) {
    assert.equal(project.stageState[stage].status, 'succeeded');
    assert.equal(project.stageState[stage].origin, 'skill-test-import');
    assert.ok(project.stageState[stage].taskId);
  }
  assert.equal(await readFile(join(project.root, 'outline', 'outline-report.html'), 'utf8'), '<img src="outline.png">');
  assert.equal(await readFile(join(project.root, 'characters', 'images', '小林-sheet.png'), 'utf8'), 'character');
  assert.equal(await readFile(join(project.root, 'storyboard', 'E01-01', 'f1.png'), 'utf8'), 'frame');
  await assert.rejects(readFile(join(project.root, 'logs', 'build-storyboard.mjs')));
  await assert.rejects(readFile(join(project.root, '.gates.jsonl')));

  const tasks = await createTaskStore(project.root).list();
  assert.deepEqual(new Set(tasks.map((task) => task.type)), new Set(['outline', 'characters', 'art', 'script', 'storyboard']));
  assert.ok(tasks.every((task) => task.status === 'succeeded' && task.imported === true));
  const manifest = await readJson(join(project.root, '.workbench', 'imports', 'skill-test', 'import.json'));
  assert.deepEqual(manifest.stages, ['outline', 'characters', 'art', 'script', 'storyboard']);
  assert.deepEqual(manifest.excluded, ['logs', '.gates.jsonl']);
});
