# Project Home and Workflow Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前单页三栏工作台改造成项目首页与项目工作流两级界面，并把原 Skill 流程进度移动到工作流页顶栏。

**Architecture:** 保留现有 Node HTTP API、项目存储、任务队列、SSE 和成果物预览，仅重构浏览器端信息架构。使用纯前端 Hash 路由区分首页、项目工作流和当前步骤；`router.mjs` 负责无 DOM 的路由解析，`app.js` 负责数据加载、页面渲染和事件绑定。首页只管理项目进入，工作流页由顶栏步骤导航、中央步骤工作区和右侧任务日志组成。

**Tech Stack:** 原生 HTML、CSS、ES modules、Node test runner、现有 Iconsax SVG sprite；不新增 npm 依赖，不改后端 API。

## Global Constraints

- 不修改 `skills/`、`skills.lock.json` 的现有内容或 Skill 运行协议。
- 保留现有 API：项目、资料、任务、SSE、成果物、视频任务和 Skill 同步接口不改路径和请求语义。
- 顶栏步骤点击只导航，不创建任务；只有步骤工作区的执行按钮调用 Skill 或视频任务 API。
- 路由使用 Hash：`#/`、`#/projects/:projectId/workflow`、`#/projects/:projectId/workflow/:stage`。
- 原六个 Skill 阶段顺序不变，工作台最终视频任务作为第七个“成片”阶段展示。
- 所有新 UI 图标使用 `/icons/iconsax.svg#...`，禁止 Emoji 和装饰性 Unicode 图标。
- 每个任务完成后运行对应聚焦测试并提交一个小提交；最终运行 `node workbench/cli.mjs test`。

---

### Task 1: Add pure Hash route model

**Files:**
- Create: `workbench/public/router.mjs`
- Create: `workbench/tests/router.test.mjs`
- Modify: `workbench/tests/ui-smoke.test.mjs`

**Interfaces:**
- `router.mjs` exports `STAGE_KEYS`, `parseHash(hash)`, `workflowHash(projectId, stage)`, and `defaultStage(stageState)`.
- `parseHash('#/')` returns `{ view: 'home' }`.
- `parseHash('#/projects/demo/workflow')` returns `{ view: 'workflow', projectId: 'demo', stage: null }`.
- `parseHash('#/projects/demo/workflow/script')` returns `{ view: 'workflow', projectId: 'demo', stage: 'script' }`.
- Unknown stages and malformed project paths return `{ view: 'home' }`.

- [ ] **Step 1: Write the failing route tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultStage, parseHash, workflowHash } from '../public/router.mjs';

test('parses home and workflow hashes', async () => {
  assert.deepEqual(parseHash('#/'), { view: 'home' });
  assert.deepEqual(parseHash('#/projects/demo/workflow'), { view: 'workflow', projectId: 'demo', stage: null });
  assert.deepEqual(parseHash('#/projects/demo/workflow/script'), { view: 'workflow', projectId: 'demo', stage: 'script' });
});

test('rejects malformed routes and chooses the first incomplete stage', async () => {
  assert.deepEqual(parseHash('#/projects/demo/other'), { view: 'home' });
  assert.deepEqual(parseHash('#/projects/demo/workflow/unknown'), { view: 'home' });
  assert.equal(defaultStage({ outline: { status: 'succeeded' }, characters: { status: 'running' } }), 'characters');
  assert.equal(workflowHash('demo', 'storyboard'), '#/projects/demo/workflow/storyboard');
});
```

- [ ] **Step 2: Run the route test and confirm it fails**

Run: `node --test workbench/tests/router.test.mjs`

Expected: FAIL because `workbench/public/router.mjs` does not exist.

- [ ] **Step 3: Implement the route module**

Implement `STAGE_KEYS` as `['outline', 'characters', 'art', 'script', 'storyboard', 'image', 'video']`. Decode only the project id and stage path segments, accept only stage keys, and use `#/` as the fallback for every invalid route. `defaultStage` returns the first stage without a terminal `succeeded` or `partial` state and returns `video` when all stages are terminal.

- [ ] **Step 4: Run the route and UI smoke tests**

Run: `node --test workbench/tests/router.test.mjs workbench/tests/ui-smoke.test.mjs`

Expected: PASS after updating the UI smoke assertions to require the router import, seven stage labels, and Hash route tokens.

- [ ] **Step 5: Commit the route boundary**

```bash
git add workbench/public/router.mjs workbench/tests/router.test.mjs workbench/tests/ui-smoke.test.mjs
git commit -m "feat(workbench): add hash route model"
```

### Task 2: Replace the static single-page shell with home/workflow mount points

**Files:**
- Modify: `workbench/public/index.html`
- Modify: `workbench/public/app.js`
- Modify: `workbench/public/styles.css`
- Modify: `workbench/tests/ui-smoke.test.mjs`

**Interfaces:**
- `index.html` contains a stable `#appRoot`, `#toastRegion`, and a minimal topbar shell; it no longer hard-codes the project rail or workflow stage list.
- `app.js` imports `parseHash`, `workflowHash`, and `defaultStage`, stores `state.view`, `state.route`, and `state.activeStage`, and exposes `window.WorkbenchApp.navigate(path)` for browser smoke tests.
- `render()` calls `renderHome()` for `{ view: 'home' }` and `renderWorkflow()` for `{ view: 'workflow' }`.

- [ ] **Step 1: Add static shell assertions**

Extend `ui-smoke.test.mjs` to assert `#appRoot`, `parseHash`, `renderHome`, `renderWorkflow`, and the absence of the old static `workflowStages` rail markup in `index.html`.

- [ ] **Step 2: Run the focused UI test and confirm the shell assertion fails**

Run: `node --test workbench/tests/ui-smoke.test.mjs`

Expected: FAIL because the current document still contains the old static three-column shell and no `#appRoot`.

- [ ] **Step 3: Implement the minimal mount-point shell**

Replace the hard-coded page body with the shared report header, `main#appRoot`, and toast region. Keep the static Iconsax sprite references needed by the header. Add the module import for `router.mjs` and a `hashchange` listener. Preserve `window.WorkbenchApi` and all existing API request functions.

- [ ] **Step 4: Add the empty home view**

Implement `renderHome()` with a project list container and a single `newProjectButton`. When `state.projects` is empty, render only the empty project message and new-project action; do not render task logs, artifact panes, upload controls, or stage controls. Bind the button through delegated event handling so it survives re-renders.

- [ ] **Step 5: Add home visual primitives**

Add report-style home classes for the project directory, empty state, project cards, metadata rows, and the “进入工作流” action. Reuse existing paper/panel/ink/seal tokens, Iconsax `folder-add`, `folder-open`, `arrow-right-2`, and `document-text` icons. Add narrow-layout rules that keep one project card per row without horizontal overflow.

- [ ] **Step 6: Run focused tests and commit the shell**

Run: `node --test workbench/tests/ui-smoke.test.mjs && git diff --check`

Expected: PASS.

```bash
git add workbench/public/index.html workbench/public/app.js workbench/public/styles.css workbench/tests/ui-smoke.test.mjs
git commit -m "feat(workbench): add project home shell"
```

### Task 3: Add project navigation and workflow topbar

**Files:**
- Modify: `workbench/public/app.js`
- Modify: `workbench/public/styles.css`
- Modify: `workbench/tests/ui-smoke.test.mjs`

**Interfaces:**
- `navigate(path)` updates `window.location.hash`; it does not call any task API.
- `selectProject(projectId)` loads the project, tasks, and artifacts, then navigates to `workflowHash(projectId, defaultStage(project.stageState))`.
- `renderWorkflowTopbar()` renders seven `[data-stage-nav]` buttons, each carrying `data-stage` and a status class.
- `renderWorkflow()` renders the topbar, active-stage mount point, and task inspector for the selected project.

- [ ] **Step 1: Add navigation contract assertions**

Extend `ui-smoke.test.mjs` to require `data-stage-nav`, `renderWorkflowTopbar`, `navigate`, `hashchange`, and all seven stage labels in `app.js`. Add a static assertion that `data-stage-nav` handlers call navigation rather than `createTask`.

- [ ] **Step 2: Run focused tests and confirm the new contract fails**

Run: `node --test workbench/tests/ui-smoke.test.mjs`

Expected: FAIL because the old app has stage action buttons but no topbar navigation.

- [ ] **Step 3: Implement project-to-workflow navigation**

Change `createProject()` to call `navigate(workflowHash(project.id))` after the API returns. Change project cards to call `navigate(workflowHash(project.id))`. On `hashchange`, load the route’s project and render; when the route points to a missing project, return home and show a toast.

- [ ] **Step 4: Implement the topbar stage navigation**

Render the seven stages in order. Derive each status from `state.project.readiness`, `state.project.stageState`, and the latest task. Clicking a stage only calls `navigate(workflowHash(state.project.id, stage.key))`. Do not call `WorkbenchApi.createTask` from the stage-nav listener.

- [ ] **Step 5: Implement the central workflow layout**

Render a back-to-projects control, project title, topbar stage navigation, central `stageWorkspace`, and right `taskInspector`. Keep the existing task log/event stream and artifact viewer functions, but mount them inside the workflow view rather than the home view.

- [ ] **Step 6: Run focused tests and commit the topbar**

Run: `node --test workbench/tests/router.test.mjs workbench/tests/ui-smoke.test.mjs && git diff --check`

Expected: PASS.

```bash
git add workbench/public/app.js workbench/public/styles.css workbench/tests/ui-smoke.test.mjs
git commit -m "feat(workbench): move workflow progress into topbar"
```

### Task 4: Implement stage-specific execution and artifact workspaces

**Files:**
- Modify: `workbench/public/app.js`
- Modify: `workbench/public/styles.css`
- Modify: `workbench/tests/ui-smoke.test.mjs`

**Interfaces:**
- `renderStageWorkspace(stageKey)` renders the selected stage’s description, readiness gate, action button, stage task summary, and filtered artifact panel.
- `runStage(type)` remains the only path for `POST /api/projects/:id/tasks`; it is bound only to `[data-stage-action]` inside the active workspace.
- `renderVideoWorkspace()` renders the provider selector and binds `videoJobButton` to the existing video-job API.

- [ ] **Step 1: Add stage workspace assertions**

Extend `ui-smoke.test.mjs` to require `renderStageWorkspace`, `data-stage-action`, `data-artifact-stage`, `createTask`, `createVideoJob`, and the explicit copy that step navigation does not auto-run.

- [ ] **Step 2: Run focused tests and confirm the workspace contract fails**

Run: `node --test workbench/tests/ui-smoke.test.mjs`

Expected: FAIL because execution controls are currently rendered in the old left-side stage list.

- [ ] **Step 3: Move execution controls into the active stage workspace**

Render a single primary action for the active Skill stage. Keep existing readiness gates and image owner-stage prompt. For a completed or partial stage, label the action “重新执行”; for a ready stage, label it “执行”. Navigation buttons must not share the action listener.

- [ ] **Step 4: Filter and display stage-owned artifacts**

Use the stage output directories and image owner metadata to filter the existing artifact collection for the active stage. Keep the existing `openArtifact()` preview behavior for reports, JSON, Markdown, images, and videos. If no artifact exists, render an Iconsax empty state specific to that stage.

- [ ] **Step 5: Add the final video workspace**

Render provider selection and the existing “创建视频任务” action only on the `video` stage. Keep the provider-specific request path and task refresh behavior; do not expose video creation as a side effect of entering the `video` tab.

- [ ] **Step 6: Run focused tests and commit the stage workspaces**

Run: `node --test workbench/tests/router.test.mjs workbench/tests/ui-smoke.test.mjs workbench/tests/http-api.test.mjs && git diff --check`

Expected: PASS.

```bash
git add workbench/public/app.js workbench/public/styles.css workbench/tests/ui-smoke.test.mjs
git commit -m "feat(workbench): add stage execution workspaces"
```

### Task 5: Verify browser behavior, regression suite, and locked Skill boundary

**Files:**
- Modify: `workbench/tests/live-smoke.mjs` only if the existing browser smoke entry points need route assertions
- Modify: `workbench/tests/ui-smoke.test.mjs` only for final regression assertions

**Interfaces:**
- Browser smoke opens `http://127.0.0.1:4318/#/`, verifies the empty home state, creates a fixture project through the existing API, opens its workflow route, switches tabs, and confirms no task is created by navigation.

- [ ] **Step 1: Run all local tests before browser verification**

Run: `node workbench/cli.mjs test`

Expected: all Skill self-tests, report self-test, workbench tests, fixture benchmark, repeatability check, and locked Skill tree checks pass.

- [ ] **Step 2: Verify the running service and route shell**

Run: `curl -sS http://127.0.0.1:4318/api/health` and verify `{"ok":true,"codex":{"available":true}}`. Open `http://127.0.0.1:4318/#/` and verify the project home, not the old file URL.

- [ ] **Step 3: Verify the empty home and workflow navigation**

Use the in-app browser to check: empty home contains only the new-project action; after creating a fixture project, the workflow page shows the topbar stages; clicking a stage changes the URL and active workspace while the task count stays unchanged.

- [ ] **Step 4: Verify refresh and responsive layout**

Refresh a deep-link workflow URL and confirm the selected project and stage return. Inspect the desktop and narrow layouts for no horizontal overflow, no left-side stage progress list, and visible topbar stage navigation.

- [ ] **Step 5: Verify the Skill boundary and working tree**

Run:

```bash
git diff main...HEAD --name-only -- skills
git status --short --branch
git diff --check
```

Expected: no Skill files changed, a clean working tree after the final commit, and no whitespace errors.

- [ ] **Step 6: Commit final regression adjustments**

```bash
git add workbench/tests/live-smoke.mjs workbench/tests/ui-smoke.test.mjs
git commit -m "test(workbench): verify project and workflow navigation"
```
