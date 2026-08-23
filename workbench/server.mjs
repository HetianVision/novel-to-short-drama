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
import { readiness, STAGE_DEFINITIONS, IMAGE_OWNER_STAGES } from './lib/task-definitions.mjs';
import { indexArtifacts } from './lib/artifact-index.mjs';
import { resolveInside } from './lib/path-utils.mjs';
import { createStageRunner } from './lib/stage-runner.mjs';
import { buildImageTask, createImageRunner } from './lib/image-runner.mjs';
import { buildVideoTask, createVideoRunner } from './lib/video-task-runner.mjs';
import { createSkillSync } from './lib/sync-skills.mjs';
import { loadProviderConfig } from './lib/providers/provider-config.mjs';

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
  videoRunner = null,
  videoFetchImpl = globalThis.fetch,
  videoDownloadFetchImpl = videoFetchImpl,
  videoEnv = process.env,
  videoAssetResolver = null,
  skillSync = null,
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
  const defaultImageRunner = createImageRunner({
    repoRoot,
    skillsRoot: join(repoRoot, 'skills'),
    skillLockPath: join(repoRoot, 'skills.lock.json'),
    projectStore,
    getTaskStore,
    codexBin,
  });
  const defaultVideoRunner = videoRunner ?? createVideoRunner({
      repoRoot,
      projectStore,
      getTaskStore,
      fetchImpl: videoFetchImpl,
      downloadFetchImpl: videoDownloadFetchImpl,
      env: videoEnv,
      assetResolver: videoAssetResolver,
    });
  const skillSyncService = skillSync ?? createSkillSync({
    repoRoot,
    skillsRoot: join(repoRoot, 'skills'),
    lockPath: join(repoRoot, 'skills.lock.json'),
  });
  const defaultRunner = async (task, context) => {
    if (task.type === 'image') return defaultImageRunner(task, context);
    if (task.type === 'video') return defaultVideoRunner(task, context);
    return defaultTaskRunner(task, context);
  };
  const queue = taskQueue ?? new TaskQueue({ runTask: taskRunner ?? defaultRunner });

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
    let definition = STAGE_DEFINITIONS[type];
    let taskSpec = null;
    if (!definition) {
      const error = new Error(`Unknown task type: ${type}`);
      error.statusCode = 400;
      throw error;
    }
    if (type === 'image') {
      const ownerStage = options.ownerStage;
      if (!IMAGE_OWNER_STAGES.includes(ownerStage)) {
        const error = new Error('Image task requires ownerStage: characters, art, or storyboard');
        error.statusCode = 400;
        throw error;
      }
      const ownerGate = readiness(project, ownerStage);
      if (!ownerGate.ok) {
        const error = new Error('Image owner stage is not ready');
        error.statusCode = 409;
        error.details = { missing: ownerGate.missing, warnings: ownerGate.warnings };
        throw error;
      }
      taskSpec = buildImageTask({
        projectId: project.id,
        ownerStage,
        assetIds: options.assetIds ?? [],
        options,
      });
      definition = STAGE_DEFINITIONS.image;
    }
    if (type === 'video') {
      if (!['minimax-h3', 'seedance'].includes(options.provider)) {
        const error = new Error('Video task requires provider: minimax-h3 or seedance');
        error.statusCode = 400;
        throw error;
      }
      const gate = readiness(project, 'video');
      if (!gate.ok) {
        const error = new Error('Video task dependencies are not ready');
        error.statusCode = 409;
        error.details = { missing: gate.missing, warnings: gate.warnings };
        throw error;
      }
      taskSpec = buildVideoTask({ projectId: project.id, provider: options.provider, options });
      definition = STAGE_DEFINITIONS.video;
    }
    const gate = ['image'].includes(type) ? { ok: true, missing: [], warnings: [] } : readiness(project, type);
    if (!gate.ok) {
      const error = new Error('Task dependencies are not ready');
      error.statusCode = 409;
      error.details = { missing: gate.missing, warnings: gate.warnings };
      throw error;
    }
    const store = getTaskStore(project);
    const task = await store.create({
      id: `task-${randomUUID()}`,
      projectId: project.id,
      type,
      status: 'queued',
      options,
      skillName: taskSpec?.skillName ?? definition.skillName,
      outputDir: taskSpec?.outputDir ?? definition.outputDirs[0] ?? null,
      ...(taskSpec?.ownerStage ? { ownerStage: taskSpec.ownerStage } : {}),
      ...(taskSpec?.assetIds ? { assetIds: taskSpec.assetIds } : {}),
      ...(taskSpec?.provider ? { provider: taskSpec.provider } : {}),
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

    if (pathname === '/api/skills/status' && method === 'GET') {
      return sendJson(response, 200, await skillSyncService.check());
    }
    if (pathname === '/api/skills/check-update' && method === 'POST') {
      return sendJson(response, 200, await skillSyncService.check());
    }
    if (pathname === '/api/skills/sync' && method === 'POST') {
      const body = await readJson(request);
      return sendJson(response, 200, await skillSyncService.sync({ confirm: body.confirm, pushOrigin: body.pushOrigin === true }));
    }
    if (pathname === '/api/providers' && method === 'GET') {
      const providers = [];
      for (const provider of ['minimax-h3', 'seedance']) {
        const config = await loadProviderConfig(provider, { providersRoot: join(repoRoot, 'providers') });
        providers.push({
          id: provider,
          model: config.requestPolicy.defaultModel,
          endpoint: config.requestPolicy.endpoint,
          configured: Boolean(videoEnv[config.requestPolicy.apiKeyEnv]),
          referencePolicy: config.referencePolicy,
          requestPolicy: { ...config.requestPolicy, apiKeyEnv: undefined },
        });
      }
      return sendJson(response, 200, providers);
    }

    if (pathname === '/api/projects' && method === 'GET') {
      const projects = [];
      for (const project of await projectStore.list()) projects.push(await readProjectPayload(project));
      return sendJson(response, 200, projects);
    }
    if (pathname === '/api/projects' && method === 'POST') {
      const body = await readJson(request);
      const source = body.source;
      if (!source || typeof source.filename !== 'string' || typeof source.contentBase64 !== 'string') {
        return sendError(response, 400, 'source file is required');
      }
      const encoded = source.contentBase64.trim();
      if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        return sendError(response, 400, 'source file content is invalid');
      }
      const bytes = Buffer.from(encoded, 'base64');
      if (!bytes.byteLength || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
        return sendError(response, 400, 'source file content is invalid');
      }
      const project = await projectStore.create({
        title: body.title,
        id: body.id,
        source: { filename: source.filename, bytes },
      });
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
      if (suffix === 'video-jobs' && method === 'POST') {
        const body = await readJson(request);
        const task = await createTask(project, 'video', { ...(body.options ?? {}), provider: body.provider });
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

    const taskActionMatch = pathname.match(/^\/api\/(tasks|video-jobs)\/([^/]+)\/(cancel|retry)$/);
    if (taskActionMatch && method === 'POST') {
      const { project, store, task } = await resolveTask(taskActionMatch[2]);
      if (taskActionMatch[3] === 'cancel') {
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
