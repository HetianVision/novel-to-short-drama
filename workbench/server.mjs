import { createServer as createHttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  contentTypeFor,
  readBody,
  readJson,
  sendError,
  sendFile,
  sendJson,
  sendText,
} from './lib/http-utils.mjs';
import { REPO_ROOT, PROJECTS_ROOT, WORKBENCH_ROOT } from './lib/constants.mjs';
import { createProjectStore } from './lib/project-store.mjs';
import { createTaskStore } from './lib/task-store.mjs';
import { TaskQueue } from './lib/task-queue.mjs';
import { readiness, STAGE_DEFINITIONS } from './lib/task-definitions.mjs';
import { indexArtifacts } from './lib/artifact-index.mjs';
import { resolveInside } from './lib/path-utils.mjs';
import { createStageRunner } from './lib/stage-runner.mjs';

const execFileAsync = promisify(execFile);
const PUBLIC_ROOT = join(WORKBENCH_ROOT, 'public');
const TERMINAL = new Set(['succeeded', 'failed', 'partial', 'cancelled']);

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    const error = new Error('Malformed URL encoding');
    error.statusCode = 400;
    throw error;
  }
}

function projectPayload(project, readinessByStage, artifacts = []) {
  const { root: _root, ...safe } = project;
  return {
    ...safe,
    readiness: readinessByStage,
    artifactSummary: artifacts.reduce((summary, artifact) => {
      summary[artifact.type] = (summary[artifact.type] ?? 0) + 1;
      return summary;
    }, {}),
  };
}

async function detectCodex(codexBin = process.env.CODEX_BIN ?? 'codex') {
  if (codexBin.includes('/') && !existsSync(codexBin)) return false;
  try {
    await execFileAsync(codexBin, ['--version'], { timeout: 3000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

export function createServer({
  repoRoot = REPO_ROOT,
  projectStore = createProjectStore({ projectsRoot: PROJECTS_ROOT }),
  taskQueue,
  taskStore,
  taskRunner = null,
  skillLock = null,
  codexBin = process.env.CODEX_BIN ?? 'codex',
  publicRoot = PUBLIC_ROOT,
} = {}) {
  const taskStores = new Map();
  const taskProjectIds = new Map();
  const sseClients = new Map();
  async function getProject(projectId) {
    return projectStore.read(decode(projectId));
  }

  function getTaskStore(project) {
    if (taskStore && typeof taskStore === 'function') return taskStore(project);
    if (taskStore && typeof taskStore.read === 'function') return taskStore;
    if (!taskStores.has(project.id)) taskStores.set(project.id, createTaskStore(project.root));
    return taskStores.get(project.id);
  }

  const defaultTaskRunner = createStageRunner({
    repoRoot,
    skillsRoot: join(repoRoot, 'skills'),
    skillLockPath: join(repoRoot, 'skills.lock.json'),
    projectStore,
    getTaskStore,
    codexBin,
  });
  const queue = taskQueue ?? new TaskQueue({ runTask: taskRunner ?? defaultTaskRunner });

  async function syncQueueEvent(event) {
    const task = event.task;
    if (!task?.projectId) return;
    taskProjectIds.set(task.id, task.projectId);
    const project = await projectStore.read(task.projectId);
    const store = getTaskStore(project);
    const patch = { status: event.status };
    if (event.status === 'running') patch.startedAt = new Date().toISOString();
    if (TERMINAL.has(event.status)) patch.finishedAt = new Date().toISOString();
    if (event.result?.error) patch.error = event.result.error;
    if (event.result?.artifactIds) patch.artifactIds = event.result.artifactIds;
    await store.update(task.id, patch);
    const definition = STAGE_DEFINITIONS[task.type];
    if (definition?.outputDirs?.length) {
      const latest = await projectStore.read(task.projectId);
      await projectStore.update(task.projectId, {
        stageState: {
          ...(latest.stageState ?? {}),
          [task.type]: {
            ...(latest.stageState?.[task.type] ?? {}),
            status: event.status,
            taskId: task.id,
            skillName: task.skillName ?? definition.skillName,
            outputDir: definition.outputDirs[0],
            ...(event.result?.artifactIds ? { artifactIds: event.result.artifactIds } : {}),
            ...(event.result?.error ? { error: event.result.error } : {}),
          },
        },
      });
    }
    const eventPayload = {
      type: event.type,
      taskId: task.id,
      projectId: task.projectId,
      status: event.status,
      result: event.result ?? null,
      at: new Date().toISOString(),
    };
    await store.appendEvent(task.id, eventPayload);
    for (const response of sseClients.get(task.id) ?? []) {
      if (!response.writableEnded) response.write(`data: ${JSON.stringify(eventPayload)}\n\n`);
    }
  }

  if (typeof queue.onState === 'function') {
    const previous = queue.onState;
    queue.onState = (event) => {
      previous(event);
      void syncQueueEvent(event).catch(() => {});
    };
  }

  async function resolveTask(taskId) {
    const decoded = decode(taskId);
    const knownProjectId = taskProjectIds.get(decoded);
    if (knownProjectId) {
      const project = await projectStore.read(knownProjectId);
      return { project, store: getTaskStore(project), task: await getTaskStore(project).read(decoded) };
    }
    for (const project of await projectStore.list()) {
      const store = getTaskStore(project);
      try {
        const task = await store.read(decoded);
        taskProjectIds.set(decoded, project.id);
        return { project, store, task };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const error = new Error(`Task not found: ${decoded}`);
    error.statusCode = 404;
    throw error;
  }

  async function stageReadiness(project) {
    const result = {};
    for (const type of Object.keys(STAGE_DEFINITIONS)) result[type] = readiness(project, type);
    return result;
  }

  async function readProjectPayload(project) {
    let artifacts = [];
    try { artifacts = await indexArtifacts(project.root); } catch { /* incomplete project can still be opened */ }
    return projectPayload(project, await stageReadiness(project), artifacts);
  }

  async function createTask(project, type, options = {}, retryOf = null) {
    const gate = readiness(project, type);
    if (!gate.ok) {
      const error = new Error('Task dependencies are not ready');
      error.statusCode = 409;
      error.details = { missing: gate.missing, warnings: gate.warnings };
      throw error;
    }
    const store = getTaskStore(project);
    const definition = STAGE_DEFINITIONS[type];
    const task = await store.create({
      id: `task-${randomUUID()}`,
      projectId: project.id,
      type,
      status: 'queued',
      options,
      skillName: definition.skillName,
      outputDir: definition.outputDirs[0] ?? null,
      retryOf,
    });
    taskProjectIds.set(task.id, project.id);
    await store.appendEvent(task.id, {
      type: 'task.queued', taskId: task.id, projectId: project.id, status: 'queued', at: new Date().toISOString(),
    });
    void Promise.resolve(queue.enqueue(task)).catch((error) => syncQueueEvent({
      type: 'task.failed', task, status: 'failed', result: { status: 'failed', error: error.message },
    }));
    return task;
  }

  async function serveArtifact(response, project, encodedPath) {
    const requested = decode(encodedPath);
    if (!requested || requested.startsWith('/') || requested.includes('\\') || requested.split('/').includes('..')) {
      return sendError(response, 400, 'Unsafe artifact path');
    }
    const artifacts = await indexArtifacts(project.root);
    const artifact = artifacts.find((candidate) => candidate.relativePath === requested);
    if (!artifact) return sendError(response, 404, 'Artifact not found');
    const absolute = resolveInside(project.root, requested);
    return sendFile(response, absolute, contentTypeFor(requested));
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const { pathname } = url;
    const method = request.method ?? 'GET';

    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(response, 200, { ok: true, codex: { available: await detectCodex(codexBin) } });
    }

    if (pathname === '/api/projects' && method === 'GET') {
      const projects = [];
      for (const project of await projectStore.list()) projects.push(await readProjectPayload(project));
      return sendJson(response, 200, projects);
    }
    if (pathname === '/api/projects' && method === 'POST') {
      const body = await readJson(request);
      const project = await projectStore.create({ title: body.title, id: body.id });
      return sendJson(response, 201, await readProjectPayload(project));
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
    if (projectMatch) {
      const projectId = decode(projectMatch[1]);
      const suffix = projectMatch[2] ? decode(projectMatch[2]) : '';
      const project = await projectStore.read(projectId);

      if (!suffix && method === 'GET') return sendJson(response, 200, await readProjectPayload(project));
      if (suffix === 'sources' && method === 'POST') {
        const filename = url.searchParams.get('filename');
        if (!filename) return sendError(response, 400, 'filename query parameter is required');
        const result = await projectStore.saveSource(project.id, filename, await readBody(request));
        const { path: _path, ...safe } = result;
        return sendJson(response, 201, safe);
      }
      if (suffix === 'tasks' && method === 'GET') {
        return sendJson(response, 200, await getTaskStore(project).list());
      }
      if (suffix === 'tasks' && method === 'POST') {
        const body = await readJson(request);
        const task = await createTask(project, body.type, body.options ?? {});
        return sendJson(response, 202, task);
      }
      if (suffix === 'artifacts' && method === 'GET') {
        return sendJson(response, 200, await indexArtifacts(project.root));
      }
      if (suffix.startsWith('artifacts/') && method === 'GET') {
        return serveArtifact(response, project, suffix.slice('artifacts/'.length));
      }
    }

    const taskEventMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/events$/);
    if (taskEventMatch && method === 'GET') {
      const { store } = await resolveTask(taskEventMatch[1]);
      const taskId = decode(taskEventMatch[1]);
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
      });
      for (const event of await store.readEvents(taskId)) response.write(`data: ${JSON.stringify(event)}\n\n`);
      const unsubscribe = store.subscribe(taskId, (event) => {
        if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      const set = sseClients.get(taskId) ?? new Set();
      set.add(response);
      sseClients.set(taskId, set);
      response.on('close', () => {
        unsubscribe();
        set.delete(response);
        if (!set.size) sseClients.delete(taskId);
      });
      return;
    }

    const taskActionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(cancel|retry)$/);
    if (taskActionMatch && method === 'POST') {
      const { project, store, task } = await resolveTask(taskActionMatch[1]);
      if (taskActionMatch[2] === 'cancel') {
        if (!queue.cancel(task.id)) return sendError(response, 409, 'Task is already terminal');
        await store.update(task.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
        return sendJson(response, 200, await store.read(task.id));
      }
      if (!['failed', 'cancelled', 'partial'].includes(task.status)) return sendError(response, 409, 'Only failed or cancelled tasks can be retried');
      const retried = await createTask(project, task.type, task.options, task.id);
      return sendJson(response, 202, retried);
    }

    if (method === 'GET' && pathname === '/') {
      return sendFile(response, join(publicRoot, 'index.html'), 'text/html; charset=utf-8');
    }
    if (method === 'GET' && !pathname.startsWith('/api/')) {
      const requested = decode(pathname.slice(1) || 'index.html');
      if (!requested || requested.startsWith('/') || requested.includes('\\') || requested.split('/').includes('..')) {
        return sendError(response, 400, 'Unsafe static path');
      }
      const absolute = resolveInside(publicRoot, requested);
      return sendFile(response, absolute, contentTypeFor(requested));
    }

    return sendError(response, 404, 'Not found');
  }

  return createHttpServer((request, response) => {
    void handle(request, response).catch((error) => {
      const status = error.statusCode ?? 500;
      const details = status < 500 ? error.details : {};
      if (!response.headersSent) sendError(response, status, status < 500 ? error.message : 'Internal server error', details);
      else response.destroy();
    });
  });
}

export async function startServer({ port = 4318, host = '127.0.0.1', ...options } = {}) {
  const server = createServer(options);
  await mkdir(PROJECTS_ROOT, { recursive: true });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolvePromise);
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4318;
  startServer({ port }).then((server) => {
    const address = server.address();
    console.log(`Workbench listening at http://${address.address}:${address.port}`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
