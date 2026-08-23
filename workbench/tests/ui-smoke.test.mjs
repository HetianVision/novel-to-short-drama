import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('index includes all approved task actions and artifact panes', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const label of ['生成大纲', '生成角色', '生成美术', '生成剧本', '生成分镜', '生成图片']) {
    assert.match(app, new RegExp(label));
  }
  assert.match(html, /id="appRoot"/);
  for (const label of ['任务日志', '成果物', '上传小说或资料', '检查更新']) assert.match(app, new RegExp(label));
});

test('browser app exposes the stable API and viewer entry points', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /window\.WorkbenchApi/);
  assert.match(app, /window\.WorkbenchApp/);
  assert.match(app, /EventSource/);
  assert.match(app, /iframe/);
});

test('static workbench uses local Iconsax icons and no decorative character icons', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /iconsax\.svg#timer-1/);
  assert.match(app, /['"]folder-add['"]/);
  assert.match(app, /['"]document-upload['"]/);
  for (const token of ['＋', '↥', '◇', '◌', '∿', '↗', '›', '幕']) {
    assert.doesNotMatch(html, new RegExp(token));
  }
});

test('workbench exposes the hash route boundary', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="appRoot"/);
  assert.match(app, /from ['"]\.\/router\.mjs['"]/);
  assert.match(app, /renderHome/);
  assert.match(app, /renderWorkflow/);
  for (const token of ['workflowHash', 'hashchange']) {
    assert.match(app, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('dynamic workbench rendering uses the fixed Iconsax helper', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function icon\(name/);
  assert.match(app, /iconsax\.svg#/);
  for (const token of ['↗', '›', '◇', '◌', '∿']) {
    assert.doesNotMatch(app, new RegExp(token));
  }
});
