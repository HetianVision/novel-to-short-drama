import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('index includes all approved task actions and artifact panes', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const label of ['生成大纲', '生成角色', '生成美术', '生成剧本', '生成分镜', '生成图片']) {
    assert.match(app, new RegExp(label));
  }
  assert.match(html, /任务日志/);
  assert.match(html, /成果物/);
  assert.match(html, /上传小说或资料/);
  assert.match(html, /检查 Skill 更新/);
});

test('browser app exposes the stable API and viewer entry points', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /window\.WorkbenchApi/);
  assert.match(app, /window\.WorkbenchApp/);
  assert.match(app, /EventSource/);
  assert.match(app, /iframe/);
});
