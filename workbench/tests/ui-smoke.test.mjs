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

test('project workflow stages live in the first-level topbar', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="appTopbar"/);
  assert.match(html, /id="topbarBrand"/);
  assert.match(html, /id="workflowTopbar"/);
  assert.match(html, /id="workflowNav"/);
  assert.match(app, /function setTopbarMode\(/);
  assert.match(app, /workflowTopbarProject/);
  assert.doesNotMatch(app, /<nav class="stage-nav" id="workflowNav"/);
});

test('workbench layout fills the browser viewport', async () => {
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.app-shell\s*\{[^}]*min-height:\s*100dvh/);
  assert.match(styles, /\.page-shell\s*\{[^}]*width:\s*100%/);
  assert.doesNotMatch(styles, /\.page-shell\s*\{[^}]*min\(1280px/);
  assert.match(styles, /\.workflow-topbar/);
});

test('Skill update controls live on the project home', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const homeRender = app.match(/function renderHome\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const workflowRender = app.match(/function renderWorkflow\(\) \{[\s\S]*?\n\}\n\nfunction artifactBelongsToStage/)?.[0] ?? '';
  assert.match(homeRender, /LOCKED SKILLS/);
  assert.match(homeRender, /id="checkSkillsButton"/);
  assert.match(homeRender, /id="syncSkillsButton"/);
  assert.equal((homeRender.match(/void checkSkills\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(workflowRender, /LOCKED SKILLS/);
});

test('workflow stages are navigation controls, not automatic task actions', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function renderWorkflowTopbar/);
  assert.match(app, /function navigate\(/);
  assert.match(app, /data-stage-nav/);
  assert.match(app, /addEventListener\(['"]hashchange['"]/);
  for (const label of ['大纲', '角色', '美术', '剧本', '分镜', '图片', '成片']) assert.match(app, new RegExp(label));
  const stageNavigation = app.match(/if \(button\.dataset\.stageNav\)[\s\S]{0,180}/)?.[0] ?? '';
  assert.match(stageNavigation, /navigate\(workflowHash/);
  assert.doesNotMatch(stageNavigation, /createTask/);
});

test('stage workspaces own execution and artifact presentation', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function renderStageWorkspace/);
  assert.match(app, /function renderVideoWorkspace/);
  assert.match(app, /data-stage-action/);
  assert.match(app, /function stageReportArtifact/);
  assert.match(app, /class="report-viewer"/);
  assert.doesNotMatch(app, /artifact-toolbar/);
  assert.doesNotMatch(app, /artifact-catalog/);
  assert.match(app, /createTask/);
  assert.match(app, /createVideoJob/);
  assert.match(app, /开始执行/);
});

test('dynamic workbench rendering uses the fixed Iconsax helper', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function icon\(name/);
  assert.match(app, /iconsax\.svg#/);
  for (const token of ['↗', '›', '◇', '◌', '∿']) {
    assert.doesNotMatch(app, new RegExp(token));
  }
});

test('new projects require a source file before creation', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="newProjectDialog"/);
  assert.match(html, /id="newProjectForm"/);
  assert.match(html, /id="sourceFileInput"/);
  assert.match(app, /function fileToBase64/);
  assert.match(app, /function createProject\(title, file\)/);
  assert.match(app, /contentBase64/);
  assert.doesNotMatch(app, /uploadSource\(/);
});

test('home projects use full-card grid navigation and an all-skills module', async () => {
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /data-project-open/);
  assert.doesNotMatch(app, /<button class="row-arrow project-open/);
  assert.match(app, /skills-directory/);
  assert.match(app, /全部 Skill/);
  assert.match(app, /SKILL_CATALOG/);
  assert.match(styles, /\.project-list\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill/);
});

test('workflow detail removes source module and keeps task log behind a toggle', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /SOURCE MATERIAL/);
  assert.match(app, /id="taskLogToggle"/);
  assert.match(app, /function toggleTaskLog/);
  assert.match(app, /const taskLogHidden/);
  assert.match(app, /runInspector.hidden/);
});

test('completed stages directly embed the original report page', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function stageReportArtifact/);
  assert.match(app, /class="report-viewer"/);
  assert.match(app, /<iframe/);
  assert.match(app, /开始执行/);
  assert.doesNotMatch(app, /artifact-toolbar/);
  assert.doesNotMatch(app, /artifact-catalog/);
});
