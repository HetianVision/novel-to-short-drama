# Local Short-Drama Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local browser workbench that accepts novel/material inputs, runs the original short-drama Skills through Codex CLI, exposes every task and artifact, and generates provider-specific MiniMax H3 or Seedance video jobs.

**Architecture:** A Node.js standard-library server owns project state, a serial task queue, safe file access, SSE task events, and Codex CLI child processes. The browser is a dependency-aware workflow view with artifact/report preview. Existing `skills/` remain read-only source material; every task receives a hashed read-only Skill snapshot and writes only under `projects/<project-id>/`.

**Tech Stack:** Node.js >= 18, `node:http`, `node:fs/promises`, `node:child_process`, native `fetch`, Server-Sent Events, and browser-native HTML/CSS/ES modules. No runtime npm dependency.

## Global Constraints

- Preserve the original workflow: `novel-outline` → `novel-characters` / `novel-art` / `novel-script` → `novel-storyboard` → video Provider layer.
- Do not modify any file under `skills/`; do not copy Skill rules into workbench business logic.
- Runtime service binds only to `127.0.0.1`.
- Generated project data lives under `projects/` and is ignored by Git.
- Root boundaries are `skills/`, `skills.lock.json`, `projects/`, `workbench/`, and `providers/`.
- Use `codex exec --json --sandbox workspace-write -C <run-directory> -` and pass prompts through stdin; never build shell command strings from user input.
- The default benchmark must not call Codex, image generation, Seedance, or MiniMax; live tests are explicit opt-in commands.
- Skill version and SHA-256 snapshots are recorded per task; a Skill mutation during a run fails the task.
- MiniMax H3 and Seedance have separate prompt, reference, request, polling, and output policies.
- Every task ends with a focused test run and a commit containing only that task’s files.

---

## File Map Before Implementation

Create these workbench-owned files; keep existing Skill files and `scripts/report.mjs` unchanged:

```text
skills.lock.json
providers/
├── minimax-h3/
│   ├── prompt-profile.json
│   ├── reference-policy.json
│   └── request-policy.json
└── seedance/
    ├── prompt-profile.json
    ├── reference-policy.json
    └── request-policy.json
workbench/
├── server.mjs
├── cli.mjs
├── lib/
│   ├── constants.mjs
│   ├── path-utils.mjs
│   ├── project-store.mjs
│   ├── task-store.mjs
│   ├── task-queue.mjs
│   ├── task-definitions.mjs
│   ├── prompt-builder.mjs
│   ├── codex-events.mjs
│   ├── codex-runner.mjs
│   ├── skill-lock.mjs
│   ├── artifact-index.mjs
│   ├── report-runner.mjs
│   ├── http-utils.mjs
│   ├── canonical-shot-job.mjs
│   ├── episode-renderer.mjs
│   ├── providers/
│   │   ├── provider-config.mjs
│   │   ├── minimax-h3.mjs
│   │   ├── seedance.mjs
│   │   └── video-runner.mjs
│   └── sync-skills.mjs
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── tests/
    ├── run.mjs
    ├── helpers.mjs
    └── *.test.mjs
projects/.gitkeep
```

The test suite uses Node’s built-in test runner. `workbench/tests/run.mjs` is a thin wrapper so the documented command remains stable.

---

### Task 1: Workbench Bootstrap, Test Harness, and Directory Boundaries

**Files:**
- Create: `workbench/lib/constants.mjs`
- Create: `workbench/tests/run.mjs`
- Create: `workbench/tests/helpers.mjs`
- Create: `workbench/tests/constants.test.mjs`
- Create: `projects/.gitkeep`
- Modify: `.gitignore`

**Interfaces:**
- Export `REPO_ROOT`, `PROJECTS_ROOT`, `WORKBENCH_ROOT`, `PROVIDERS_ROOT`, `SKILLS_ROOT` from `workbench/lib/constants.mjs`.
- Export `runNodeTests(files)` from `workbench/tests/run.mjs`.
- Export `makeTempDir(prefix)`, `writeJson(path, value)`, `readJson(path)`, and `assertFileMissing(path)` from `workbench/tests/helpers.mjs`.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { REPO_ROOT, PROJECTS_ROOT, SKILLS_ROOT } from '../lib/constants.mjs';

test('root paths stay inside the repository', () => {
  assert.equal(PROJECTS_ROOT, `${REPO_ROOT}/projects`);
  assert.equal(SKILLS_ROOT, `${REPO_ROOT}/skills`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test workbench/tests/constants.test.mjs`

Expected: FAIL because `workbench/lib/constants.mjs` does not exist.

- [ ] **Step 3: Write minimal implementation**

Use `fileURLToPath(import.meta.url)` and `resolve()` so all roots are absolute. Do not read an environment variable for the repository root; derive it from the file location.

- [ ] **Step 4: Add the test wrapper and ignore generated data**

`workbench/tests/run.mjs` must execute `node --test` with explicit test files or the default `workbench/tests/*.test.mjs`. Add `/projects/*` with an exception for `/projects/.gitkeep`, plus workbench runtime logs and temporary task directories, to `.gitignore`. Do not add any pattern that ignores `skills/*` or committed examples.

- [ ] **Step 5: Run test to verify it passes**

Run: `node workbench/tests/run.mjs`

Expected: PASS with the constants test.

- [ ] **Step 6: Commit**

```bash
git add -- .gitignore projects/.gitkeep workbench/lib/constants.mjs workbench/tests
git commit -m "feat(workbench): add runtime roots and test harness"
```

### Task 2: Safe Path Utilities and Project/Source Store

**Files:**
- Create: `workbench/lib/path-utils.mjs`
- Create: `workbench/lib/project-store.mjs`
- Create: `workbench/tests/path-utils.test.mjs`
- Create: `workbench/tests/project-store.test.mjs`

**Interfaces:**
- `assertSafeId(value): string` accepts lowercase letters, digits, and single hyphens; rejects empty values, `..`, slashes, absolute paths, and path separators.
- `resolveInside(root, ...parts): string` returns an absolute path only when the resolved result stays under `root`.
- `createProjectStore({ projectsRoot, now }): { list, create, read, update, saveSource }` persists `project.json` and source files under `projects/<id>/`.
- `saveSource(projectId, filename, bytes): Promise<{ path, sha256, size }>` refuses path traversal and writes atomically through a temporary file in the same project.

- [ ] **Step 1: Write the failing tests**

```js
test('rejects traversal and absolute project ids', () => {
  assert.throws(() => assertSafeId('../escape'), /safe id/i);
  assert.throws(() => assertSafeId('/tmp/project'), /safe id/i);
});

test('source upload stays inside project source directory', async () => {
  const result = await store.saveSource('demo-project', 'novel.txt', Buffer.from('渡口'));
  assert.match(result.path, /projects[\\/]demo-project[\\/]source[\\/]novel\.txt$/);
  assert.equal(await readFile(result.path, 'utf8'), '渡口');
});

test('source upload refuses nested traversal', async () => {
  await assert.rejects(store.saveSource('demo-project', '../outside.txt', Buffer.from('x')), /path/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test workbench/tests/path-utils.test.mjs workbench/tests/project-store.test.mjs`

Expected: FAIL because the path and store modules do not exist.

- [ ] **Step 3: Implement safe paths and durable project state**

Store project metadata as `.workbench/project.json` with `id`, `title`, `createdAt`, `updatedAt`, `sources`, and `stageState`. Use SHA-256 from `node:crypto`. Write JSON with a trailing newline and use `rename()` for atomic replacement. Create all original output directories (`outline`, `characters`, `art`, `script`, `storyboard`, `video`) when creating a project.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test workbench/tests/path-utils.test.mjs workbench/tests/project-store.test.mjs`

Expected: PASS, including traversal rejection and source hash assertions.

- [ ] **Step 5: Commit**

```bash
git add -- workbench/lib/path-utils.mjs workbench/lib/project-store.mjs workbench/tests/path-utils.test.mjs workbench/tests/project-store.test.mjs
git commit -m "feat(workbench): add safe project and source storage"
```

### Task 3: Skill Lock, Hash Verification, and Read-Only Snapshots

**Files:**
- Create: `workbench/lib/skill-lock.mjs`
- Create: `workbench/tests/skill-lock.test.mjs`
- Create: `skills.lock.json`

**Interfaces:**
- `readSkillVersions(skillsRoot): Promise<Record<string, string>>` reads `version:` from each direct Skill `SKILL.md`.
- `buildSkillLock({ skillsRoot, sourceCommit, sourceUrl, now }): Promise<object>` returns the lock object for all direct Skill directories.
- `writeSkillLock(lockPath, lock): Promise<void>` writes stable key ordering.
- `verifySkillLock(lockPath, skillsRoot): Promise<{ ok, mismatches }>` checks versions and SHA-256 values.
- `snapshotSkill({ skillsRoot, skillName, destination }): Promise<{ root, files, hashes }>` copies one Skill into a read-only directory with directories `0555` and files `0444`.

- [ ] **Step 1: Write the failing tests**

```js
test('lock contains every direct Skill and a hash', async () => {
  const lock = await buildSkillLock({ skillsRoot: fixtureSkills, sourceCommit: 'fixture-sha', sourceUrl: 'fixture' });
  assert.equal(lock.sourceCommit, 'fixture-sha');
  assert.equal(typeof lock.skills['novel-outline'].sha256, 'string');
  assert.equal(lock.skills['novel-outline'].version, '1.2.0');
});

test('verification catches a changed Skill file', async () => {
  await writeFile(join(fixtureSkills, 'novel-outline', 'SKILL.md'), 'version: 9.9.9\n');
  const result = await verifySkillLock(lockPath, fixtureSkills);
  assert.equal(result.ok, false);
  assert.match(result.mismatches.join('\n'), /novel-outline/);
});

test('snapshot cannot be written by the task workspace', async () => {
  const snapshot = await snapshotSkill({ skillsRoot: fixtureSkills, skillName: 'novel-outline', destination: tempDir });
  const mode = (await stat(join(snapshot.root, 'SKILL.md'))).mode & 0o222;
  assert.equal(mode, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test workbench/tests/skill-lock.test.mjs`

Expected: FAIL because lock and snapshot functions do not exist.

- [ ] **Step 3: Implement lock generation and snapshot copying**

Include all direct Skill folders, including `shot-recipes`. Hash every regular file under each Skill with normalized relative paths and file bytes. The committed lock uses the current `upstream/main` commit recorded by `git rev-parse upstream/main`; do not write generated timestamps during normal verification.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test workbench/tests/skill-lock.test.mjs`

Expected: PASS, including read-only mode and changed-file detection.

- [ ] **Step 5: Commit**

```bash
git add -- skills.lock.json workbench/lib/skill-lock.mjs workbench/tests/skill-lock.test.mjs
git commit -m "feat(workbench): lock Skill versions and snapshots"
```

### Task 4: Task Model, Dependency Gates, Queue, and Event Store

**Files:**
- Create: `workbench/lib/task-store.mjs`
- Create: `workbench/lib/task-queue.mjs`
- Create: `workbench/lib/task-definitions.mjs`
- Create: `workbench/tests/task-store.test.mjs`
- Create: `workbench/tests/task-queue.test.mjs`
- Create: `workbench/tests/task-definitions.test.mjs`

**Interfaces:**
- `createTaskStore(projectRoot): { create, read, update, list, appendEvent, readEvents }` persists one task record and one `events/<task-id>.jsonl` file.
- `TaskQueue({ runTask, maxConcurrent = 1 })` exposes `enqueue(task): Promise<TaskResult>`, `cancel(taskId)`, and `get(taskId)`; `enqueue` resolves after that task reaches a terminal state, and the queue starts no more than one Codex task by default.
- `STAGE_DEFINITIONS` contains `outline`, `characters`, `art`, `script`, `storyboard`, and `image`, with `skillName`, `outputDirs`, and `readiness(project)`.
- `readiness(project, taskType)` returns `{ ok, missing, warnings }` and follows the original Skill contracts: outline is the root; script needs outline; storyboard needs script; cast/art are optional where the original Skill says optional.

- [ ] **Step 1: Write the failing tests**

```js
test('storyboard is blocked without script', () => {
  const result = readiness(projectWithoutScript, 'storyboard');
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['script.json']);
});

test('queue runs only one task at a time', async () => {
  let active = 0;
  let maxActive = 0;
  const queue = new TaskQueue({ maxConcurrent: 1, runTask: async task => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(10);
    active -= 1;
  }});
  await Promise.all([queue.enqueue({ id: 'a' }), queue.enqueue({ id: 'b' })]);
  assert.equal(maxActive, 1);
});

test('event log survives a store reload', async () => {
  await store.appendEvent('task-a', { type: 'task.started' });
  assert.deepEqual(await createTaskStore(projectRoot).readEvents('task-a'), [{ type: 'task.started' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test workbench/tests/task-store.test.mjs workbench/tests/task-queue.test.mjs workbench/tests/task-definitions.test.mjs`

Expected: FAIL because the task modules do not exist.

- [ ] **Step 3: Implement durable task state and original dependency gates**

Task records must include `id`, `projectId`, `type`, `status`, `createdAt`, `startedAt`, `finishedAt`, `options`, `skillSnapshot`, `artifactIds`, and `error`. Queue transitions must append `task.queued`, `task.started`, and terminal events through the store.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test workbench/tests/task-store.test.mjs workbench/tests/task-queue.test.mjs workbench/tests/task-definitions.test.mjs`

Expected: PASS, including serial execution and storyboard gating.

- [ ] **Step 5: Commit**

```bash
git add -- workbench/lib/task-store.mjs workbench/lib/task-queue.mjs workbench/lib/task-definitions.mjs workbench/tests/task-store.test.mjs workbench/tests/task-queue.test.mjs workbench/tests/task-definitions.test.mjs
git commit -m "feat(workbench): add task state and workflow gates"
```

### Task 5: Codex JSONL Runner, Prompt Builder, Artifact Checks, and Report Hook

**Files:**
- Create: `workbench/lib/codex-events.mjs`
- Create: `workbench/lib/codex-runner.mjs`
- Create: `workbench/lib/prompt-builder.mjs`
- Create: `workbench/lib/artifact-index.mjs`
- Create: `workbench/lib/report-runner.mjs`
- Create: `workbench/tests/codex-events.test.mjs`
- Create: `workbench/tests/codex-runner.test.mjs`
- Create: `workbench/tests/prompt-builder.test.mjs`
- Create: `workbench/tests/artifact-index.test.mjs`

**Interfaces:**
- `parseJsonlLine(line): object | null` parses one Codex event and returns `null` for blank lines only; malformed nonblank lines become an `error` event rather than crashing the queue.
- `runCodex({ codexBin, cwd, prompt, signal, onEvent, onStderr }): Promise<{ exitCode, threadId, finalMessage }>` spawns with `['exec', '--json', '--sandbox', 'workspace-write', '-C', cwd, '-']`.
- `buildSkillPrompt({ task, project, skillSnapshot, inputPaths }): string` returns a deterministic prompt naming the read-only Skill path, writable output path, required commands, and forbidden paths.
- `indexArtifacts(projectRoot): Promise<Artifact[]>` returns safe relative paths, type (`json`, `markdown`, `report`, `image`, `video`, `other`), byte size, and SHA-256.
- `assertExpectedArtifacts(taskType, artifacts): void` throws a named error when required JSON or report files are missing.
- `renderAggregateReport({ repoRoot, projectRoot, outputPath }): Promise<void>` calls the existing `scripts/report.mjs` through `execFile`, never imports or modifies Skill code.

- [ ] **Step 1: Write the failing tests**

```js
test('JSONL parser preserves Codex event type and thread id', () => {
  const event = parseJsonlLine('{"type":"thread.started","thread_id":"t1"}');
  assert.deepEqual(event, { type: 'thread.started', thread_id: 't1' });
});

test('runner captures stderr and terminal exit code', async () => {
  const result = await runCodex({ codexBin: fixtureCodexPath, cwd: tempDir, prompt: 'fixture', onEvent, onStderr });
  assert.equal(result.exitCode, 0);
  assert.equal(result.threadId, 'fixture-thread');
  assert.match(stderr.join(''), /fixture stderr/);
});

test('prompt forbids Skill writes and names only the stage output directory', () => {
  const prompt = buildSkillPrompt({ task: { type: 'outline' }, project, skillSnapshot, inputPaths });
  assert.match(prompt, /Do not modify.*skills/i);
  assert.match(prompt, /outline/);
});

test('artifact index classifies report, image, and JSON', async () => {
  const artifacts = await indexArtifacts(projectRoot);
  assert.deepEqual(new Set(artifacts.map(x => x.type)), new Set(['json', 'report', 'image']));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test workbench/tests/codex-events.test.mjs workbench/tests/codex-runner.test.mjs workbench/tests/prompt-builder.test.mjs workbench/tests/artifact-index.test.mjs`

Expected: FAIL because the runner, parser, prompt builder, and indexer do not exist.

- [ ] **Step 3: Implement the runner and post-run checks**

Use `spawn()` with `stdio: ['pipe', 'pipe', 'pipe']`. Write the prompt to stdin, parse stdout line by line, and persist every event through the task store callback. On `SIGTERM`, resolve as cancelled only after the child exits. Snapshot the Skill before starting; verify it after finishing; run the expected artifact check and report hook before marking success. The report hook must call `scripts/report.mjs --from <project-root> --out <project-root>/.workbench/report.html`, allowing the existing Skill renderers to preserve relative image paths.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test workbench/tests/codex-events.test.mjs workbench/tests/codex-runner.test.mjs workbench/tests/prompt-builder.test.mjs workbench/tests/artifact-index.test.mjs`

Expected: PASS with no real Codex invocation.

- [ ] **Step 5: Commit**

```bash
git add -- workbench/lib/codex-events.mjs workbench/lib/codex-runner.mjs workbench/lib/prompt-builder.mjs workbench/lib/artifact-index.mjs workbench/lib/report-runner.mjs workbench/tests/codex-events.test.mjs workbench/tests/codex-runner.test.mjs workbench/tests/prompt-builder.test.mjs workbench/tests/artifact-index.test.mjs
git commit -m "feat(workbench): run Codex tasks and index artifacts"
```

### Task 6: HTTP API, SSE Events, Uploads, and Task Dispatch

**Files:**
- Create: `workbench/server.mjs`
- Create: `workbench/lib/http-utils.mjs`
- Create: `workbench/tests/http-api.test.mjs`

**Interfaces:**
- `createServer({ repoRoot, projectStore, taskQueue, taskStore, skillLock }): http.Server` returns a server suitable for `listen(0)` in tests.
- `POST /api/projects` accepts `{ "title": "渡口" }` and returns `201` with the project JSON.
- `GET /api/projects` and `GET /api/projects/:id` list and read project state, including stage readiness and artifact summaries.
- `POST /api/projects/:id/sources?filename=novel.txt` accepts raw bytes and returns the source record.
- `GET /api/projects/:id/tasks` lists durable task records.
- `POST /api/projects/:id/tasks` accepts `{ "type": "outline", "options": {} }`, checks readiness, creates a task, and returns `202`.
- `POST /api/tasks/:id/cancel` and `POST /api/tasks/:id/retry` cancel or safely requeue a task.
- `GET /api/tasks/:id/events` keeps an SSE connection and emits stored plus live events as `data: <json>\n\n`.
- `GET /api/projects/:id/artifacts` lists indexed artifacts.
- `GET /api/projects/:id/artifacts/*path` serves only indexed files under the project root with safe content types.
- `GET /api/health` returns `{ "ok": true, "codex": { "available": boolean } }`.
- `GET /api/skills/status` and `POST /api/skills/check-update` expose lock verification and read-only upstream status.
- `POST /api/skills/sync` requires the explicit confirmation payload and returns the sync branch and commit without credentials.
- `GET /api/providers` returns configured provider capabilities without exposing API keys.
- `POST /api/projects/:id/video-jobs` creates a provider job from the canonical shot input; `POST /api/video-jobs/:id/cancel` requests cancellation.

- [ ] **Step 1: Write the failing API tests**

```js
test('creates project and uploads raw source', async () => {
  const project = await post('/api/projects', { title: '渡口' });
  const source = await fetch(`${base}/api/projects/${project.id}/sources?filename=novel.txt`, {
    method: 'POST', body: '小说正文', headers: { 'content-type': 'text/plain' }
  });
  assert.equal(source.status, 201);
});

test('blocks storyboard before script exists', async () => {
  const response = await post(`/api/projects/${project.id}/tasks`, { type: 'storyboard', options: {} });
  assert.equal(response.status, 409);
  assert.deepEqual((await response.json()).missing, ['script.json']);
});

test('artifact route rejects traversal', async () => {
  const response = await fetch(`${base}/api/projects/${project.id}/artifacts/..%2F..%2Fpackage.json`);
  assert.equal(response.status, 400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test workbench/tests/http-api.test.mjs`

Expected: FAIL because no HTTP server exists.

- [ ] **Step 3: Implement routes and SSE**

Use a small method/path router with explicit route checks. Do not use `eval`, `Function`, shell interpolation, or unbounded request bodies. Cap JSON and upload bodies at 100 MiB. Start queued tasks through `taskQueue.enqueue()` and wire task events to connected SSE clients.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test workbench/tests/http-api.test.mjs`

Expected: PASS for project creation, upload, dependency conflict, traversal rejection, and SSE event delivery.

- [ ] **Step 5: Commit**

```bash
git add -- workbench/server.mjs workbench/lib/http-utils.mjs workbench/tests/http-api.test.mjs
git commit -m "feat(workbench): expose local project and task API"
```

### Task 7: Browser Workbench and Artifact Viewer

**Files:**
- Create: `workbench/public/index.html`
- Create: `workbench/public/app.js`
- Create: `workbench/public/styles.css`
- Create: `workbench/tests/ui-smoke.test.mjs`

**Interfaces:**
- `window.WorkbenchApi` exposes `listProjects()`, `createProject(title)`, `uploadSource(projectId, file)`, `createTask(projectId, type, options)`, `cancelTask(taskId)`, `retryTask(taskId)`, and `subscribeTask(taskId, onEvent)`.
- `window.WorkbenchApi` also exposes `createVideoJob(projectId, provider, options)`, `cancelVideoJob(jobId)`, `checkSkillUpdate()`, and `syncSkills(confirmToken)`; these methods map to the guarded API routes and never expose provider credentials.
- `window.WorkbenchApp` exposes `renderProject(project)` and `renderTaskEvent(event)` for deterministic smoke tests.
- The UI uses the exact task labels “生成大纲”“生成角色”“生成美术”“生成剧本”“生成分镜”“生成图片”.

- [ ] **Step 1: Write the failing UI smoke test**

```js
test('index includes all approved task actions and artifact panes', async () => {
  const html = await readFile('workbench/public/index.html', 'utf8');
  assert.match(html, /生成大纲/);
  assert.match(html, /生成分镜/);
  assert.match(html, /生成图片/);
  assert.match(html, /任务日志/);
  assert.match(html, /成果物/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test workbench/tests/ui-smoke.test.mjs`

Expected: FAIL because the static UI files do not exist.

- [ ] **Step 3: Implement the UI**

Build a three-column layout: workflow/status on the left, selected artifact/report in the center, task log on the right. Include source/material upload, Provider selection for video jobs, and separate “检查 Skill 更新” / “确认同步” controls. Disable buttons from API readiness data. Use `EventSource` for logs, `<iframe>` for reports, `<pre>` for JSON/Markdown, `<img>` for images, and `<video controls>` for MP4. Every rendered artifact URL must come from the API rather than concatenating arbitrary user input.

- [ ] **Step 4: Run tests and a live static smoke**

Run: `node --test workbench/tests/ui-smoke.test.mjs`

Then run: `node workbench/server.mjs --port 0` and request `/`, `/api/health`, and one artifact route with `curl`.

Expected: PASS and the browser displays the project shell, six approved task buttons, task log, and artifact panel.

- [ ] **Step 5: Commit**

```bash
git add -- workbench/public/index.html workbench/public/app.js workbench/public/styles.css workbench/tests/ui-smoke.test.mjs
git commit -m "feat(workbench): add local workflow and artifact UI"
```

### Task 8: Wire Stage Buttons to Original Skills

**Files:**
- Modify: `workbench/lib/task-definitions.mjs`
- Modify: `workbench/lib/prompt-builder.mjs`
- Modify: `workbench/lib/project-store.mjs`
- Modify: `workbench/server.mjs`
- Create: `workbench/tests/stage-dispatch.test.mjs`

**Interfaces:**
- `STAGE_DEFINITIONS.outline`, `.characters`, `.art`, `.script`, and `.storyboard` each declare the exact Skill name, output directory, required command, and artifact predicates.
- `createStageTask({ projectId, type, options }): Promise<Task>` constructs a task without modifying the Skill source.
- `runStageTask(task): Promise<TaskResult>` snapshots the requested Skill, builds the prompt, runs Codex, validates artifacts, and updates stage state.

- [ ] **Step 1: Write the failing dispatch tests**

```js
test('outline task prompt points to novel-outline and outline output', () => {
  const task = createStageTask({ projectId: 'demo-project', type: 'outline', options: {} });
  assert.equal(task.skillName, 'novel-outline');
  assert.equal(task.outputDir, 'outline');
  assert.match(task.prompt, /novel-outline[\\/]SKILL\.md/);
});

test('storyboard task includes script and optional upstream paths', () => {
  const task = createStageTask({ projectId: 'demo-project', type: 'storyboard', options: { episodes: '1-3' } });
  assert.match(task.prompt, /script\.json/);
  assert.match(task.prompt, /storyboard/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test workbench/tests/stage-dispatch.test.mjs`

Expected: FAIL because stage prompts and task dispatch are not wired.

- [ ] **Step 3: Implement stage dispatch**

Use the existing Skill instructions as the only source of stage behavior. The prompt must ask Codex to run each Skill’s documented `seed`, model-writing step, `validate`, `render`, and `export` commands where applicable. The workbench must not generate replacement JSON itself.

- [ ] **Step 4: Run the fake-Codex integration test**

Set `CODEX_BIN` to a fixture executable that writes valid JSONL events and deterministic sample outputs, then run:

```bash
CODEX_BIN="$PWD/workbench/tests/fixtures/codex-fixture.mjs" node --test workbench/tests/stage-dispatch.test.mjs
```

Expected: PASS with `outline`, `characters`, `art`, `script`, and `storyboard` tasks reaching the expected terminal state without any `skills/` diff.

- [ ] **Step 5: Commit**

```bash
git add -- workbench/lib/task-definitions.mjs workbench/lib/prompt-builder.mjs workbench/lib/project-store.mjs workbench/server.mjs workbench/tests/stage-dispatch.test.mjs workbench/tests/fixtures
git commit -m "feat(workbench): dispatch the original short-drama Skills"
```

### Task 9: Image Task Routing and Report Regeneration

**Files:**
- Modify: `workbench/lib/task-definitions.mjs`
- Modify: `workbench/lib/prompt-builder.mjs`
- Modify: `workbench/server.mjs`
- Create: `workbench/tests/image-task.test.mjs`

**Interfaces:**
- `buildImageTask({ projectId, ownerStage, assetIds, options }): Task` requires `ownerStage` to be `characters`, `art`, or `storyboard`.
- `image` tasks write only to the owner stage’s documented image directory.
- `image` terminal state is `succeeded` when all requested images exist, `partial` when prompts or some images exist, and `failed` when the Codex process or output contract fails.

- [ ] **Step 1: Write the failing tests**

```js
test('image task rejects an unknown owner stage', () => {
  assert.throws(() => buildImageTask({ projectId: 'demo-project', ownerStage: 'script', assetIds: ['S01'] }), /owner stage/i);
});

test('missing image is partial, not successful', async () => {
  const result = await classifyImageResult({ requested: ['S01', 'S02'], present: ['S01'], promptFiles: ['S01.prompt.md', 'S02.prompt.md'], processExitCode: 0 });
  assert.equal(result.status, 'partial');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test workbench/tests/image-task.test.mjs`

Expected: FAIL because image task routing is not implemented.

- [ ] **Step 3: Implement image routing and report refresh**

Keep the task visible as “生成图片”, but require the owner stage in the request. After successful or partial image output, call the corresponding Skill `render --html` through the existing report contract so the report immediately reflects available images.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test workbench/tests/image-task.test.mjs`

Expected: PASS for owner validation and partial classification.

- [ ] **Step 5: Commit**

```bash
git add -- workbench/lib/task-definitions.mjs workbench/lib/prompt-builder.mjs workbench/server.mjs workbench/tests/image-task.test.mjs
git commit -m "feat(workbench): route image generation by owning Skill stage"
```

### Task 10: Canonical Shot Jobs and Provider-Specific Prompt/Reference Compilers

**Files:**
- Create: `providers/minimax-h3/prompt-profile.json`
- Create: `providers/minimax-h3/reference-policy.json`
- Create: `providers/minimax-h3/request-policy.json`
- Create: `providers/seedance/prompt-profile.json`
- Create: `providers/seedance/reference-policy.json`
- Create: `providers/seedance/request-policy.json`
- Create: `workbench/lib/canonical-shot-job.mjs`
- Create: `workbench/lib/providers/provider-config.mjs`
- Create: `workbench/lib/providers/minimax-h3.mjs`
- Create: `workbench/lib/providers/seedance.mjs`
- Create: `workbench/tests/canonical-shot-job.test.mjs`
- Create: `workbench/tests/provider-compilers.test.mjs`

**Interfaces:**
- `buildCanonicalShotJobs({ projectRoot, storyboardPath, castPath, artPath, scriptPath }): Promise<CanonicalShotJob[]>` resolves C/P/S references and local media paths without changing source JSON.
- `compileMiniMaxH3(job, config): ProviderInput` returns `model`, `content`, `duration`, `resolution`, and any H3-specific fields.
- `compileSeedance(job, config): ProviderInput` returns Seedance `content`, `model`, `duration`, `ratio`, `resolution`, and audio settings.
- `validateProviderInput(provider, input): void` rejects unsupported reference role combinations before network calls.

- [ ] **Step 1: Write the failing tests**

```js
test('canonical job resolves storyboard C/P ids to reference assets', async () => {
  const [job] = await buildCanonicalShotJobs(fixturePaths);
  assert.equal(job.segmentId, 'E01-01');
  assert.ok(job.references.some(ref => ref.kind === 'character' && ref.assetId === 'C01'));
  assert.ok(job.references.some(ref => ref.kind === 'scene' && ref.assetId === 'S01'));
});

test('H3 compiler keeps H3 alignment prompt and first-frame role', () => {
  const input = compileMiniMaxH3(h3Job, h3Config);
  assert.equal(input.content.find(x => x.type === 'image_url').role, 'first_frame');
  assert.match(input.content.find(x => x.type === 'text').text, /Picture 1/);
});

test('Seedance compiler does not send H3 prompt unchanged', () => {
  const input = compileSeedance(seedanceJob, seedanceConfig);
  assert.notEqual(input.content.find(x => x.type === 'text').text, seedanceJob.h3Prompt);
  assert.match(input.content.find(x => x.type === 'text').text, /camera|镜头/i);
});

test('Seedance rejects reference_image mixed with first_frame mode', () => {
  assert.throws(() => validateProviderInput('seedance', mixedSeedanceInput), /mutually exclusive/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test workbench/tests/canonical-shot-job.test.mjs workbench/tests/provider-compilers.test.mjs`

Expected: FAIL because canonical mapping and provider compilers do not exist.

- [ ] **Step 3: Implement the normalized job and two independent compilers**

The canonical job contains `projectId`, `episodeId`, `segmentId`, `duration`, `ratio`, `style`, `cuts`, `dialogue`, `sound`, and typed `references`. MiniMax H3 uses its own `h3Prompt` and `content[]` roles. Seedance uses its own concise prompt profile and explicit mode policy; it must not receive H3 alignment syntax as its text prompt.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test workbench/tests/canonical-shot-job.test.mjs workbench/tests/provider-compilers.test.mjs`

Expected: PASS, including reference-role validation and prompt inequality.

- [ ] **Step 5: Commit**

```bash
git add -- providers workbench/lib/canonical-shot-job.mjs workbench/lib/providers/provider-config.mjs workbench/lib/providers/minimax-h3.mjs workbench/lib/providers/seedance.mjs workbench/tests/canonical-shot-job.test.mjs workbench/tests/provider-compilers.test.mjs
git commit -m "feat(workbench): compile provider-specific shot inputs"
```

### Task 11: Provider API Clients, Video Jobs, and Optional Episode Assembly

**Files:**
- Create: `workbench/lib/providers/video-runner.mjs`
- Create: `workbench/lib/episode-renderer.mjs`
- Modify: `workbench/server.mjs`
- Create: `workbench/tests/video-runner.test.mjs`
- Create: `workbench/tests/episode-renderer.test.mjs`

**Interfaces:**
- `submitVideoJob({ provider, input, fetchImpl, env }): Promise<{ providerTaskId }>` submits a provider-specific request.
- `pollVideoJob({ provider, providerTaskId, fetchImpl, onStatus, signal }): Promise<{ status, videoUrl, metadata }>` polls until success, failure, cancellation, or abort.
- `downloadVideo(url, destination, fetchImpl): Promise<{ path, sha256, size }>` writes the returned MP4 under `projects/<id>/video/`.
- `renderEpisode({ segmentPaths, outputPath, ffmpegBin = 'ffmpeg' }): Promise<void>` uses a generated concat list and rejects missing segments.

- [ ] **Step 1: Write the failing tests**

```js
test('MiniMax mock submit and poll return task content url', async () => {
  const result = await pollVideoJob({ provider: 'minimax-h3', providerTaskId: 'mm-1', fetchImpl: minimaxMockFetch, onStatus() {} });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.videoUrl, 'https://cdn.example/mm-1.mp4');
});

test('Seedance failed status preserves provider error', async () => {
  await assert.rejects(pollVideoJob({ provider: 'seedance', providerTaskId: 'sd-1', fetchImpl: seedanceFailedFetch }), /provider failed/i);
});

test('episode renderer rejects a missing segment before invoking ffmpeg', async () => {
  await assert.rejects(renderEpisode({ segmentPaths: ['/tmp/E01-01.mp4', '/tmp/missing.mp4'], outputPath: '/tmp/E01.mp4', ffmpegBin: fixtureFfmpeg }), /missing/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test workbench/tests/video-runner.test.mjs workbench/tests/episode-renderer.test.mjs`

Expected: FAIL because provider clients and assembly are not implemented.

- [ ] **Step 3: Implement asynchronous provider clients**

Implement MiniMax H3 at `POST /v2/video_generation` with polling at `/v2/query/video_generation/{task_id}`. Implement Seedance at `POST /api/v3/contents/generations/tasks` with polling at `/api/v3/contents/generations/tasks/{task_id}`. Read API keys only from the configured environment variable; never store the key in project JSON, task events, or browser responses. Persist the exact sanitized input snapshot before submission.

- [ ] **Step 4: Implement optional episode assembly**

Check `ffmpeg` availability first. Build a concat file using absolute paths that have already passed project-root checks. Use `-f concat -safe 0 -c copy` for the first pass; if it fails, return a diagnostic and retain all segment files.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test workbench/tests/video-runner.test.mjs workbench/tests/episode-renderer.test.mjs`

Expected: PASS with mocked HTTP and fixture `ffmpeg`, without network or model spend.

- [ ] **Step 6: Commit**

```bash
git add -- workbench/lib/providers/video-runner.mjs workbench/lib/episode-renderer.mjs workbench/server.mjs workbench/tests/video-runner.test.mjs workbench/tests/episode-renderer.test.mjs
git commit -m "feat(workbench): submit video jobs and assemble episodes"
```

### Task 12: Skill Update Check and Confirmed Sync to Origin

**Files:**
- Create: `workbench/lib/sync-skills.mjs`
- Modify: `workbench/server.mjs`
- Modify: `workbench/public/app.js`
- Create: `workbench/tests/sync-skills.test.mjs`

**Interfaces:**
- `checkSkillUpdate({ repoRoot, upstreamRemote = 'upstream', branch = 'main' }): Promise<{ current, remote, changedFiles }>` performs read-only `git` commands.
- `syncSkills({ repoRoot, sourceRemote = 'upstream', destinationRemote = 'origin', sourceBranch = 'main', runSelftests }): Promise<{ branch, commit, pushed }>` runs only after an explicit API request.
- The UI exposes “检查 Skill 更新” and “确认同步” as separate actions; no startup action changes files.

- [ ] **Step 1: Write the failing tests**

```js
test('update check is read-only', async () => {
  const before = await gitHead(repoRoot);
  const result = await checkSkillUpdate({ repoRoot, upstreamRemote: 'fixture-upstream' });
  assert.equal(await gitHead(repoRoot), before);
  assert.equal(typeof result.remote, 'string');
});

test('sync refuses when Skill selftests fail', async () => {
  await assert.rejects(syncSkills({ repoRoot, runSelftests: async () => { throw new Error('selftest failed'); } }), /selftest failed/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test workbench/tests/sync-skills.test.mjs`

Expected: FAIL because no sync module exists.

- [ ] **Step 3: Implement guarded sync**

Use `git fetch upstream main`, create a `sync/skills-YYYYMMDD-HHmmss` branch, update only Skill files and `skills.lock.json`, run every `skills/*/scripts/selftest.mjs`, commit, and push to `origin`. Reject a dirty worktree before sync and leave the worktree untouched on any failed selftest. The sync API must return the commit and branch, not credentials.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test workbench/tests/sync-skills.test.mjs`

Expected: PASS for read-only check, failed-selftest rollback path, and destination remote selection.

- [ ] **Step 5: Commit**

```bash
git add -- workbench/lib/sync-skills.mjs workbench/server.mjs workbench/public/app.js workbench/tests/sync-skills.test.mjs
git commit -m "feat(workbench): add confirmed Skill update sync"
```

### Task 13: Full Benchmark Fixture, CLI, Documentation, and Verification

**Files:**
- Create: `workbench/cli.mjs`
- Create: `workbench/tests/fixtures/codex-fixture.mjs`
- Create: `workbench/tests/fixtures/ffmpeg-fixture.mjs`
- Create: `workbench/tests/e2e-fixture.test.mjs`
- Create: `workbench/tests/live-smoke.mjs`
- Create: `workbench/README.md`
- Modify: `README.md`

**Interfaces:**
- `node workbench/cli.mjs start --port 4318` starts the local server on `127.0.0.1:4318`.
- `node workbench/cli.mjs test` runs `scripts/report-selftest.mjs`, all existing Skill selftests, all workbench tests, and the deterministic fixture benchmark.
- `node workbench/cli.mjs skills-lock` rebuilds `skills.lock.json` from the current upstream commit without changing Skill files.
- `node workbench/cli.mjs live-smoke --codex|--provider <name>` is opt-in and exits nonzero on an incomplete result. `--codex` includes one real image-generation smoke task; if the local Codex image capability is unavailable, the command fails with a diagnostic and the handoff must say that the real image gate is incomplete.

- [ ] **Step 1: Write the failing end-to-end benchmark**

```js
test('fixture project completes all stages and leaves Skill hashes unchanged', async () => {
  const project = await createFixtureProject();
  await runFixtureStage(project, 'outline');
  await runFixtureStage(project, 'characters');
  await runFixtureStage(project, 'art');
  await runFixtureStage(project, 'script');
  await runFixtureStage(project, 'storyboard');
  const artifacts = await indexArtifacts(project.root);
  assert.ok(artifacts.some(x => x.relativePath.endsWith('storyboard.json')));
  assert.deepEqual(await hashSkills(), initialSkillHashes);
});
```

- [ ] **Step 2: Run the complete benchmark to verify the missing implementation**

Run: `node workbench/cli.mjs test`

Expected: FAIL because the CLI, fixtures, and full runner wiring do not exist.

- [ ] **Step 3: Implement deterministic fixtures and CLI**

The Codex fixture is invoked through `process.execPath` with an explicit fixture path (it is not required to be executable), emits JSONL `thread.started`, `item.completed`, and `turn.completed` events, writes minimal valid stage JSON and reports into the task project, and exits zero. The fixture must never be used by production code. The CLI must print a concise summary with the report selftest, passed Skill selftests, workbench tests, and fixture benchmark results.

- [ ] **Step 4: Add documentation and startup validation**

Update root `README.md` with:

```bash
node workbench/cli.mjs start
node workbench/cli.mjs test
```

Document required local tools (`node`, `codex`; `ffmpeg` only for episode assembly), optional provider environment variables, project directory layout, Skill sync confirmation, and the fact that live provider tests can spend money.

- [ ] **Step 5: Run the complete default benchmark**

Run:

```bash
node workbench/cli.mjs test
git diff --check
git status --short --branch
```

Expected: `scripts/report-selftest.mjs`, all original Skill selftests, all workbench tests, and the fixture end-to-end benchmark pass; `skills/` is unchanged, and the branch contains only intended workbench files and documentation.

- [ ] **Step 6: Run the local server smoke test**

Run: `node workbench/cli.mjs start --port 4318`

Verify with `curl`:

```bash
curl --fail http://127.0.0.1:4318/api/health
curl --fail http://127.0.0.1:4318/
```

Expected: health JSON reports the server and Codex detection state; the root response contains the workbench shell.

- [ ] **Step 7: Commit**

```bash
git add -- workbench/cli.mjs workbench/tests/fixtures workbench/tests/e2e-fixture.test.mjs workbench/tests/live-smoke.mjs workbench/README.md README.md
git commit -m "test(workbench): add benchmark fixtures and local CLI"
```

## Verification Checklist Before Handoff

- [ ] `node workbench/cli.mjs test` passes.
- [ ] `node scripts/report-selftest.mjs` passes independently.
- [ ] Every existing `skills/*/scripts/selftest.mjs` passes.
- [ ] `skills/` has no diff and its lock hashes still verify.
- [ ] `node workbench/cli.mjs start --port 4318` serves the UI on `127.0.0.1`.
- [ ] A fixture project reaches all five original Skill stages.
- [ ] Browser events show `queued`, `running`, and terminal task states.
- [ ] Reports open with relative images intact.
- [ ] Image tasks distinguish `partial` from `failed`.
- [ ] MiniMax H3 and Seedance compiler tests prove prompt and reference mapping are different.
- [ ] Provider mock tests cover success, failure, cancellation, and missing credentials.
- [ ] The real Codex image-generation smoke test has been run, or the handoff explicitly marks that gate incomplete; it is never represented as a fixture pass.
- [ ] Live provider tests are documented but are not part of the default benchmark.
- [ ] No API key appears in project files, task logs, browser responses, or Git diffs.
