import { dirname, join } from 'node:path';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createTaskStore } from './task-store.mjs';
import { STAGE_DEFINITIONS } from './task-definitions.mjs';
import { indexArtifacts } from './artifact-index.mjs';
import { assertSafeFileName, assertSafeId, resolveInside } from './path-utils.mjs';

export const IMPORT_STAGES = Object.freeze(['outline', 'characters', 'art', 'script', 'storyboard']);

const OUTLINE_DOCUMENTS = Object.freeze(['outline-report.html', 'outline-report.md', 'outline-assets.json']);
const EXCLUDED_SNAPSHOT_ENTRIES = Object.freeze(['logs', '.gates.jsonl']);

function asTimestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.toISOString() : String(value);
}

async function copyTree(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Symbolic link is not allowed in import: ${source}`);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      await copyTree(join(source, entry.name), join(destination, entry.name));
    }
    return;
  }
  if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    return;
  }
  throw new Error(`Unsupported import entry: ${source}`);
}

async function copyIfPresent(source, destination) {
  try {
    await copyTree(source, destination);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertProjectDoesNotExist(projectStore, projectId) {
  try {
    await projectStore.read(projectId);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const conflict = new Error(`Project already exists: ${projectId}`);
  conflict.statusCode = 409;
  throw conflict;
}

async function importSources(sourceRoot, project, projectStore) {
  const inputRoot = join(sourceRoot, 'input');
  const entries = await readdir(inputRoot, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));
  if (!files.length) throw new Error('Skill-test import requires at least one input file');
  for (const entry of files) {
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link is not allowed in import: input/${entry.name}`);
    assertSafeFileName(entry.name);
    await projectStore.saveSource(project.id, entry.name, await readFile(join(inputRoot, entry.name)));
  }
}

async function importStageDirectories(sourceRoot, projectRoot) {
  for (const stage of IMPORT_STAGES) {
    const source = join(sourceRoot, stage);
    const destination = resolveInside(projectRoot, stage);
    if (!await copyIfPresent(source, destination)) throw new Error(`Skill-test import is missing stage directory: ${stage}`);
  }
  const docsRoot = join(sourceRoot, 'docs');
  for (const document of OUTLINE_DOCUMENTS) {
    const source = join(docsRoot, document);
    const destination = resolveInside(projectRoot, 'outline', document);
    if (!await copyIfPresent(source, destination) && document === 'outline-report.html') {
      throw new Error('Skill-test import is missing docs/outline-report.html');
    }
  }
}

function stageArtifacts(artifacts, stage) {
  const prefix = `${stage}/`;
  return artifacts.filter((artifact) => artifact.relativePath.startsWith(prefix)).map((artifact) => artifact.relativePath);
}

async function writeImportManifest(projectRoot, project, importedAt) {
  const importRoot = resolveInside(projectRoot, '.workbench', 'imports', 'skill-test');
  await mkdir(importRoot, { recursive: true });
  const manifest = {
    version: 1,
    kind: 'skill-test-import',
    projectId: project.id,
    title: project.title,
    sourceName: 'skill-test',
    importedAt,
    stages: [...IMPORT_STAGES],
    excluded: [...EXCLUDED_SNAPSHOT_ENTRIES],
  };
  await writeFile(join(importRoot, 'import.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export async function importSkillTestProject({
  sourceRoot,
  projectStore,
  projectId = 'yidi-jimao',
  title = '一地鸡毛',
  taskStoreFactory = (root) => createTaskStore(root),
  now = () => new Date().toISOString(),
} = {}) {
  if (!sourceRoot || !projectStore) throw new TypeError('Skill-test import needs sourceRoot and projectStore');
  const safeProjectId = assertSafeId(projectId);
  const importedAt = asTimestamp(now);
  await assertProjectDoesNotExist(projectStore, safeProjectId);

  let project;
  try {
    project = await projectStore.create({ id: safeProjectId, title });
    await importSources(sourceRoot, project, projectStore);
    await importStageDirectories(sourceRoot, project.root);

    const artifacts = await indexArtifacts(project.root);
    const taskStore = taskStoreFactory(project.root);
    const stageState = {};
    for (const stage of IMPORT_STAGES) {
      const definition = STAGE_DEFINITIONS[stage];
      const artifactIds = stageArtifacts(artifacts, stage);
      const taskId = `import-${stage}`;
      await taskStore.create({
        id: taskId,
        projectId: project.id,
        type: stage,
        status: 'succeeded',
        startedAt: importedAt,
        finishedAt: importedAt,
        skillName: definition.skillName,
        outputDir: stage,
        artifactIds,
        imported: true,
        options: { origin: 'skill-test', sourceName: 'skill-test' },
      });
      await taskStore.appendEvent(taskId, {
        type: 'task.imported',
        taskId,
        projectId: project.id,
        status: 'succeeded',
        message: '成果物已从 skill-test 导入。',
        at: importedAt,
      });
      stageState[stage] = {
        status: 'succeeded',
        taskId,
        skillName: definition.skillName,
        outputDir: stage,
        artifactIds,
        origin: 'skill-test-import',
        importedAt,
      };
    }

    const manifest = await writeImportManifest(project.root, project, importedAt);
    return projectStore.update(project.id, {
      stageState,
      imports: [{ ...manifest, path: '.workbench/imports/skill-test/import.json' }],
    });
  } catch (error) {
    if (project?.root) await rm(project.root, { recursive: true, force: true });
    throw error;
  }
}
