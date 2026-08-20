import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertSafeId } from './path-utils.mjs';

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8', { flag: 'wx' });
  await rename(temporary, path);
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function createTaskStore(projectRoot, { now = () => new Date().toISOString() } = {}) {
  const root = resolve(projectRoot);
  const workbenchRoot = join(root, '.workbench');
  const tasksRoot = join(workbenchRoot, 'tasks');
  const eventsRoot = join(workbenchRoot, 'events');
  const listeners = new Map();

  async function ensureRoots() {
    await mkdir(tasksRoot, { recursive: true });
    await mkdir(eventsRoot, { recursive: true });
  }

  function taskPath(taskId) {
    return join(tasksRoot, `${assertSafeId(taskId)}.json`);
  }

  function eventsPath(taskId) {
    return join(eventsRoot, `${assertSafeId(taskId)}.jsonl`);
  }

  async function create(input) {
    await ensureRoots();
    const taskId = assertSafeId(input.id ?? `task-${randomUUID()}`);
    const createdAt = input.createdAt ?? timestamp(now);
    const task = {
      id: taskId,
      projectId: input.projectId ?? null,
      type: input.type ?? null,
      status: input.status ?? 'queued',
      createdAt,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
      options: input.options ?? {},
      skillSnapshot: input.skillSnapshot ?? null,
      artifactIds: input.artifactIds ?? [],
      error: input.error ?? null,
      ...input,
      id: taskId,
      createdAt,
    };
    await writeJsonAtomic(taskPath(taskId), task);
    return task;
  }

  async function read(taskId) {
    return JSON.parse(await readFile(taskPath(taskId), 'utf8'));
  }

  async function update(taskId, patch) {
    const current = await read(taskId);
    const next = { ...current, ...patch };
    await writeJsonAtomic(taskPath(taskId), next);
    return next;
  }

  async function list() {
    await ensureRoots();
    const entries = await readdir(tasksRoot, { withFileTypes: true });
    const tasks = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      tasks.push(JSON.parse(await readFile(join(tasksRoot, entry.name), 'utf8')));
    }
    return tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function appendEvent(taskId, event) {
    await ensureRoots();
    const line = `${JSON.stringify(event)}\n`;
    await writeFile(eventsPath(taskId), line, { encoding: 'utf8', flag: 'a' });
    for (const listener of listeners.get(taskId) ?? []) listener(event);
    return event;
  }

  async function readEvents(taskId) {
    try {
      const content = await readFile(eventsPath(taskId), 'utf8');
      return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function subscribe(taskId, listener) {
    const set = listeners.get(taskId) ?? new Set();
    set.add(listener);
    listeners.set(taskId, set);
    return () => {
      set.delete(listener);
      if (!set.size) listeners.delete(taskId);
    };
  }

  return { create, read, update, list, appendEvent, readEvents, subscribe };
}
