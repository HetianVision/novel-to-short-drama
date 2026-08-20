import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { assertSafeFileName, assertSafeId, resolveInside } from './path-utils.mjs';

export const WORKFLOW_OUTPUT_DIRS = Object.freeze([
  'source',
  'outline',
  'characters',
  'art',
  'script',
  'storyboard',
  'video',
]);

function asTimestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.toISOString() : String(value);
}

async function writeJsonAtomic(path, value) {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8', { flag: 'wx' });
  await rename(tempPath, path);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeBytes(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
  throw new TypeError('Source bytes must be a Buffer, Uint8Array, or string');
}

function slugFromTitle(title) {
  const ascii = String(title)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || 'project';
}

export function createProjectStore({ projectsRoot, now = () => new Date().toISOString() }) {
  const root = resolve(projectsRoot);

  function projectRoot(projectId) {
    return resolveInside(root, assertSafeId(projectId));
  }

  async function readMetadata(projectId) {
    const projectPath = projectRoot(projectId);
    const metadataPath = join(projectPath, '.workbench', 'project.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    return { ...metadata, root: projectPath };
  }

  async function create({ id, title }) {
    if (typeof title !== 'string' || !title.trim()) throw new Error('Project title is required');
    await mkdir(root, { recursive: true });

    let projectId = id ? assertSafeId(id) : slugFromTitle(title);
    if (!id) {
      let suffix = 0;
      while (true) {
        try {
          await stat(projectRoot(projectId));
          suffix += 1;
          projectId = `${slugFromTitle(title)}-${suffix}`;
        } catch (error) {
          if (error.code === 'ENOENT') break;
          throw error;
        }
      }
    }

    const projectPath = projectRoot(projectId);
    await mkdir(projectPath);
    for (const directory of WORKFLOW_OUTPUT_DIRS) await mkdir(join(projectPath, directory));
    await mkdir(join(projectPath, '.workbench', 'events'), { recursive: true });
    await mkdir(join(projectPath, '.workbench', 'runs'), { recursive: true });

    const timestamp = asTimestamp(now);
    const metadata = {
      id: projectId,
      title: title.trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
      sources: [],
      stageState: {},
    };
    await writeJsonAtomic(join(projectPath, '.workbench', 'project.json'), metadata);
    return { ...metadata, root: projectPath };
  }

  async function list() {
    await mkdir(root, { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        projects.push(await readMetadata(entry.name));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async function read(projectId) {
    return readMetadata(projectId);
  }

  async function update(projectId, patch) {
    const current = await readMetadata(projectId);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('Project patch must be an object');
    }
    const next = {
      ...current,
      ...patch,
      id: current.id,
      updatedAt: asTimestamp(now),
    };
    delete next.root;
    await writeJsonAtomic(join(current.root, '.workbench', 'project.json'), next);
    return { ...next, root: current.root };
  }

  async function saveSource(projectId, filename, bytes) {
    const project = await readMetadata(projectId);
    assertSafeFileName(filename);
    const content = normalizeBytes(bytes);
    const sourceDirectory = resolveInside(project.root, 'source');
    const destination = resolveInside(sourceDirectory, filename);
    const tempPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, content, { flag: 'wx' });
    await rename(tempPath, destination);

    const record = {
      filename,
      relativePath: relative(project.root, destination).split(sep).join('/'),
      size: content.byteLength,
      sha256: sha256(content),
      updatedAt: asTimestamp(now),
    };
    const sources = (project.sources ?? []).filter((item) => item.filename !== filename);
    sources.push(record);
    await update(projectId, { sources });
    return { path: destination, ...record };
  }

  return { list, create, read, update, saveSource, projectRoot };
}
