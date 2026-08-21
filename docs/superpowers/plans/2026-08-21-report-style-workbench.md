# 报告风格短剧工作台视觉重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将本地短剧工作台改造成与原 Skill report 页面同源的冷灰印张界面，并用本地 Iconsax 免费 SVG 替换所有界面图标。

**Architecture:** 保留现有原生 HTML/ES module 工作台和 API，只重构 `public/` 的语义标记、图标渲染和 CSS 视觉系统。Iconsax 以本地 SVG sprite 提供，静态资源由现有 HTTP 服务正确返回；任务、项目、成果物和视频功能继续由现有状态/API 驱动。

**Tech Stack:** Node.js >= 18、原生 HTML、CSS、ES modules、SVG sprite、Node 内置 `node:test`。

## Global Constraints

- 工作台只借鉴 report 的视觉语法，不把 report 页面误做成工作台本身。
- `skills/` 下任何 Skill、脚本、规则、报告模板和锁定快照不得修改。
- 工作流阶段顺序、任务输入输出契约、API 路由和 Provider 适配逻辑保持不变。
- 所有界面图标来自 Iconsax 免费图标集合，并以本地 SVG 随工作台交付。
- 禁止 emoji、Unicode 图形字符、字符箭头和只靠图标表达主要操作。
- 不引入外部字体、远程图标字体或运行时 CDN。
- 冷灰印张 token 固定为 `--paper:#eceded`、`--panel:#f5f6f5`、`--side:#e4e6e3`、`--ink:#191d21`、`--seal:#8a3324`、`--seal-2:#c56a4e`、`--ok:#3d6b4f`。
- 宽屏优先，中央成果物区域获得最大宽度；中等宽度下运行记录下移；移动宽度下不出现横向滚动或内容重叠。
- 保留键盘焦点可见和 `prefers-reduced-motion` 支持。
- 每项完成后运行对应的定向测试并独立提交；最后运行完整基准测试和浏览器验收。

---

### Task 1: 建立 Iconsax 本地图标资产与静态资源契约

**Files:**
- Create: `workbench/public/icons/iconsax.svg`
- Modify: `workbench/lib/http-utils.mjs:65-79`
- Modify: `workbench/tests/http-api.test.mjs` 的静态资源测试

**Interfaces:**
- Produces: `/icons/iconsax.svg`，包含可通过 `<use href="/icons/iconsax.svg#<name>">` 引用的线性 SVG symbol。
- Produces: `contentTypeFor('iconsax.svg') === 'image/svg+xml'`。

- [ ] **Step 1: Write the failing static-asset test**

在 `workbench/tests/http-api.test.mjs` 的 browser asset 测试中增加：

```js
const icons = await fetch(`${base}/icons/iconsax.svg`);
assert.equal(icons.status, 200);
assert.equal(icons.headers.get('content-type'), 'image/svg+xml');
assert.match(await icons.text(), /symbol id="folder-add"/);
```

- [ ] **Step 2: Run the focused test and verify the failure**

Run:

```bash
node --test workbench/tests/http-api.test.mjs
```

Expected: the new request fails because the SVG file and SVG MIME mapping do not exist yet。

- [ ] **Step 3: Add the local Iconsax linear sprite**

创建 `workbench/public/icons/iconsax.svg`，只放本次工作台需要的 Iconsax 免费线性图标 symbol：

```text
folder-add
document-upload
folder-2
folder-open
document-text
gallery
video-play
play-circle
tick-circle
timer-1
refresh-2
rotate-right
close-circle
arrow-right-2
search-normal-1
filter
```

每个 symbol 使用 `viewBox="0 0 24 24"`、`fill="none"`、`stroke="currentColor"`、`stroke-width="1.5"`、`stroke-linecap="round"`、`stroke-linejoin="round"`，路径来自 Iconsax 免费线性 SVG 导出，不重新绘制成其他图标风格。

- [ ] **Step 4: Add SVG content-type mapping**

在 `contentTypeFor` 中加入：

```js
if (lower.endsWith('.svg')) return 'image/svg+xml';
```

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
node --test workbench/tests/http-api.test.mjs
```

Expected: all HTTP API tests pass，且 Iconsax sprite 返回 `image/svg+xml`。

- [ ] **Step 6: Commit the asset contract**

```bash
git add workbench/public/icons/iconsax.svg workbench/lib/http-utils.mjs workbench/tests/http-api.test.mjs
git commit -m "feat(workbench): add local Iconsax icon sprite"
```

### Task 2: 重构静态 HTML 的语义结构与图标占位

**Files:**
- Modify: `workbench/public/index.html`
- Modify: `workbench/tests/ui-smoke.test.mjs`

**Interfaces:**
- Consumes: `/icons/iconsax.svg` symbols from Task 1。
- Produces: 页面静态结构中的 `.icon` SVG、report 风格页眉、左侧工作流区、中央成果物区和右侧运行记录区。

- [ ] **Step 1: Extend the UI smoke test with the no-symbol contract**

在 `workbench/tests/ui-smoke.test.mjs` 增加：

```js
test('static workbench uses local Iconsax icons and no decorative character icons', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /iconsax\.svg#folder-add/);
  assert.match(html, /iconsax\.svg#document-upload/);
  for (const token of ['＋', '↥', '◇', '◌', '∿', '↗', '›', '幕']) {
    assert.doesNotMatch(html, new RegExp(token));
  }
});
```

- [ ] **Step 2: Run the focused UI test and verify the failure**

Run:

```bash
node --test workbench/tests/ui-smoke.test.mjs
```

Expected: the new test fails because the current HTML contains character icons and no local Iconsax references。

- [ ] **Step 3: Replace static character icons with Iconsax SVG references**

在 `index.html` 中：

- 删除旋转的 `幕` 字标，改为项目名称和 report 风格页眉标记；
- “新建项目”按钮使用 `folder-add` SVG + 可见文字或 `aria-label`；
- 上传区域使用 `document-upload` SVG；
- 空成果物使用 `document-text`，空预览使用 `gallery`，空任务日志使用 `timer-1`；
- 状态点改为 `tick-circle` / `close-circle` / `timer-1` 的图标容器，不使用字符点；
- 保留 `aria-label`、`aria-live`、`role` 和表单标签；
- 不改变现有元素 ID，避免破坏 `app.js` 的事件绑定。

静态图标采用如下结构：

```html
<svg class="icon icon-md" aria-hidden="true" focusable="false">
  <use href="/icons/iconsax.svg#folder-add"></use>
</svg>
```

- [ ] **Step 4: Add report-oriented semantic hooks without changing behavior**

补充用于 CSS 的语义 class：`report-header`、`project-rail`、`artifact-canvas`、`run-inspector`、`metric-strip`、`section-rule`。保留原有 `id` 和 `data-*` 属性，确保项目创建、上传、阶段执行、成果物查看、视频任务和任务日志继续使用原逻辑。

- [ ] **Step 5: Run the focused UI test and verify it passes**

Run:

```bash
node --test workbench/tests/ui-smoke.test.mjs
```

Expected: all UI smoke tests pass，静态 HTML 不再包含被禁止的字符图标。

- [ ] **Step 6: Commit the semantic markup**

```bash
git add workbench/public/index.html workbench/tests/ui-smoke.test.mjs
git commit -m "refactor(workbench): use semantic report-style markup"
```

### Task 3: 重建 report 风格的颜色、布局和响应式系统

**Files:**
- Modify: `workbench/public/styles.css`

**Interfaces:**
- Consumes: Task 2 的 semantic hooks 和 Task 1 的 `.icon` SVG。
- Produces: 冷灰印张工作台在宽屏、中等宽度、移动宽度下的稳定布局。

- [ ] **Step 1: Replace the dark token system with the report token system**

将 `:root` 改为以下固定 token，并删除深色面板、深色渐变和当前橙/薄荷色主导的 token：

```css
:root {
  color-scheme: light;
  --paper: #eceded;
  --panel: #f5f6f5;
  --side: #e4e6e3;
  --ink: #191d21;
  --muted: #68706e;
  --rule: #cfd2cf;
  --seal: #8a3324;
  --seal-2: #c56a4e;
  --ok: #3d6b4f;
  --danger: #9d3e35;
  --serif: "Songti SC", "Noto Serif SC", "STSong", serif;
  --sans: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Noto Sans SC", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

- [ ] **Step 2: Implement the report header and three-zone grid**

以以下尺寸作为初始布局基线：

```css
.workbench-grid {
  display: grid;
  grid-template-columns: minmax(280px, 320px) minmax(0, 1fr) minmax(260px, 300px);
  min-height: calc(100vh - 70px);
}

.topbar {
  min-height: 70px;
  border-bottom: 2px solid var(--ink);
  background: var(--paper);
}
```

让中央 `.artifact-workspace` 使用最大可用宽度，左侧 `.project-rail` 使用 `--side`，右侧 `.run-inspector` 使用 `--panel`，全部以细线分隔。

- [ ] **Step 3: Convert panels, buttons and status rows to report treatment**

完成以下样式替换：

- `.panel-block` 使用 `background: var(--panel)`、`border: 1px solid var(--rule)`、`box-shadow: none`、`border-radius: 0`；
- 标题使用 `var(--serif)`，辅助文字使用 `var(--sans)`，文件路径/提示词使用 `var(--mono)`；
- 选中态使用 `var(--seal)` 的细边线和浅底，不使用深色块；
- 成功使用 `var(--ok)`，运行中使用 `var(--seal-2)`，失败使用 `var(--danger)`；
- `.icon` 设置 16/18/20px 三档尺寸并继承 `currentColor`；
- 所有主要按钮显示文字，图标与文字间距固定为 6px；
- 空状态采用 `min-height`、图标、动作说明三层结构。

- [ ] **Step 4: Implement responsive layout and focus states**

在 `@media` 中实现：

- `max-width: 1180px`：右侧运行记录移动到中央成果物区域之后；
- `max-width: 860px`：左侧项目/工作流也改为单列，成果物目录位于预览之前；
- `max-width: 640px`：页眉指标换行，按钮保留文字，禁止横向滚动；
- `:focus-visible` 使用 2px `var(--seal)` 外轮廓；
- `@media (prefers-reduced-motion: reduce)` 关闭 pulse、transition 和平滑滚动。

- [ ] **Step 5: Run syntax and UI tests**

Run:

```bash
git diff --check
node --test workbench/tests/ui-smoke.test.mjs
```

Expected: no whitespace errors and all UI smoke tests pass。

- [ ] **Step 6: Commit the visual system**

```bash
git add workbench/public/styles.css
git commit -m "style(workbench): adopt report visual language"
```

### Task 4: 统一动态渲染中的 Iconsax 图标和文案

**Files:**
- Modify: `workbench/public/app.js`
- Modify: `workbench/tests/ui-smoke.test.mjs`

**Interfaces:**
- Consumes: Task 1 的固定 symbol 白名单和 Task 2 的 `.icon` 结构。
- Produces: `icon(name, className, label)` helper，只允许渲染固定 Iconsax 名称；所有动态列表和空状态不再注入字符图标。

- [ ] **Step 1: Add the fixed icon helper and dynamic-render test**

在 `app.js` 的 HTML helper 区域加入固定映射：

```js
const ICON_NAMES = new Set([
  'folder-add', 'document-upload', 'folder-2', 'folder-open',
  'document-text', 'gallery', 'video-play', 'play-circle',
  'tick-circle', 'timer-1', 'refresh-2', 'rotate-right',
  'close-circle', 'arrow-right-2', 'search-normal-1', 'filter',
]);

function icon(name, className = 'icon icon-sm') {
  if (!ICON_NAMES.has(name)) throw new Error(`Unknown Iconsax icon: ${name}`);
  return `<svg class="${className}" aria-hidden="true" focusable="false"><use href="/icons/iconsax.svg#${name}"></use></svg>`;
}
```

在 `ui-smoke.test.mjs` 增加对 `app.js` 的检查：

```js
assert.match(app, /function icon\(name/);
assert.match(app, /iconsax\.svg#/);
for (const token of ['↗', '›', '◇', '◌', '∿']) assert.doesNotMatch(app, new RegExp(token));
```

- [ ] **Step 2: Run the focused test and verify the failure**

Run:

```bash
node --test workbench/tests/ui-smoke.test.mjs
```

Expected: the test fails until the dynamic renderer uses the fixed Iconsax helper。

- [ ] **Step 3: Replace dynamic artifact, task, source and empty-state markers**

修改以下渲染点：

- `renderSources`：文件扩展名旁增加 `document-text`；
- `renderArtifactList`：按 report/json/markdown/image/video 映射 `document-text`、`gallery`、`video-play`，右侧使用 `arrow-right-2`；
- `renderTaskLog`：按状态使用 `tick-circle`、`timer-1`、`close-circle`，右侧使用 `arrow-right-2`；
- `renderArtifactList` 和 `renderTaskLog` 的空状态使用 `document-text` / `timer-1`；
- `renderStages`：阶段按钮增加 `play-circle`，已完成和运行中状态使用 Iconsax 状态图标；
- 刷新、重试、取消和 Skill 同步按钮增加 `refresh-2`、`rotate-right`、`close-circle`，保留可见文字；
- 删除所有动态模板中的 `↗`、`›`、`◇`、`◌`、`∿` 等字符。

- [ ] **Step 4: Add semantic status labels and preserve existing events**

确保动态模板继续保留以下属性和行为：

- `data-stage-action`、`data-artifact-path`、`data-task-id`；
- `aria-live="polite"` 的任务日志和事件流；
- 任务状态、项目选择、成果物预览和视频按钮的原有 disabled 条件；
- 图标只作为渲染辅助，不改变 API 请求和状态机。

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test workbench/tests/ui-smoke.test.mjs
node --test workbench/tests/http-api.test.mjs
```

Expected: all focused UI/API tests pass。

- [ ] **Step 6: Commit dynamic icon rendering**

```bash
git add workbench/public/app.js workbench/tests/ui-smoke.test.mjs
git commit -m "refactor(workbench): render Iconsax icons consistently"
```

### Task 5: 浏览器视觉验收与回归验证

**Files:**
- Modify: none unless a browser finding requires a direct CSS/markup fix
- Test: `workbench/tests/ui-smoke.test.mjs`, `workbench/tests/http-api.test.mjs`, existing benchmark tests

**Interfaces:**
- Consumes: Tasks 1–4 的本地工作台。
- Produces: 经过浏览器复核的空状态、项目状态、成果物状态、报告预览和移动布局。

- [ ] **Step 1: Run the complete deterministic test suite**

Run:

```bash
node workbench/cli.mjs test
```

Expected: report selftest、六个 Skill selftest、workbench 测试、fixture benchmark、重复性检查和 Skill tree unchanged 全部通过。

- [ ] **Step 2: Start the local server and verify health**

Run:

```bash
node workbench/cli.mjs start --port 4318
curl -sS http://127.0.0.1:4318/api/health
```

Expected: `/api/health` 返回 `{"ok":true,"codex":{"available":true}}` 或准确反映当前 Codex 状态。

- [ ] **Step 3: Inspect the empty workbench in the in-app browser**

打开 `http://127.0.0.1:4318/`，确认页眉、三栏布局、冷灰印张、Iconsax 图标、空状态文案和无横向滚动。

- [ ] **Step 4: Exercise one project state and one artifact state**

通过现有工作台创建项目并上传测试资料，确认左侧工作流、成果物目录、任务日志和报告 iframe 的视觉层级保持一致。若使用 fixture 产物，必须仍能通过现有 artifact API 预览。

- [ ] **Step 5: Check responsive and accessibility states**

在浏览器中复核约 1440px、1000px 和 640px 宽度，检查：

- 没有横向滚动；
- 右侧运行记录按规格下移；
- 所有主要按钮保留文字；
- 键盘 Tab 有清晰焦点；
- `prefers-reduced-motion` 不产生持续动画。

- [ ] **Step 6: Verify Skill tree and final worktree**

Run:

```bash
git diff --check
git status --short
node workbench/cli.mjs test
```

Expected: `skills/` 内容和哈希未变化，完整测试通过，只有本次工作台视觉重设计相关提交存在。

- [ ] **Step 7: Commit final verification notes if needed**

如果浏览器修复了直接相关的 CSS/markup 缺陷，使用单独提交记录；如果没有额外代码变更，不创建空提交。
