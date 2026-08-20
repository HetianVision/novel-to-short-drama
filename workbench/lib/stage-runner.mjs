import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { assertSafeId, resolveInside } from './path-utils.mjs';
import { STAGE_DEFINITIONS } from './task-definitions.mjs';
import { buildSkillPrompt } from './prompt-builder.mjs';
import { snapshotSkill, verifySkillLock, hashSkillDirectory } from './skill-lock.mjs';
import { runCodex } from './codex-runner.mjs';
import { indexArtifacts, assertExpectedArtifacts } from './artifact-index.mjs';
import { renderAggregateReport } from './report-runner.mjs';

const execFileAsync = promisify(execFile);
const TEXT_EXTENSIONS = /\.(txt|md|markdown)$/i;

function placeholderProjectRoot(projectId) {
  return `/projects/${assertSafeId(projectId)}`;
}

function placeholderSkillRoot(skillName) {
  return `/workbench/.runtime/skills/${assertSafeId(skillName)}`;
}

export function createStageTask({
  projectId,
  type,
  options = {},
  projectRoot = placeholderProjectRoot(projectId),
  skillSnapshotRoot = placeholderSkillRoot(STAGE_DEFINITIONS[type]?.skillName ?? type),
  inputPaths = [],
} = {}) {
  const definition = STAGE_DEFINITIONS[type];
  if (!definition || !definition.skillName) throw new Error(`Stage ${type} is not a Codex Skill stage`);
  const task = {
    projectId,
    type,
    options,
    skillName: definition.skillName,
    outputDir: definition.outputDirs[0],
  };
  return {
    ...task,
    inputPaths: [...inputPaths],
    prompt: buildSkillPrompt({
      task,
      project: { id: projectId, root: projectRoot },
      skillSnapshot: { root: skillSnapshotRoot },
      inputPaths,
    }),
  };
}

async function copyTree(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Symbolic link is not allowed in task input: ${source}`);
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
  throw new Error(`Unsupported task input: ${source}`);
}

async function readDirectJson(directory, token) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !/manifest|\.gates/i.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().includes(token.toLowerCase()))
    .sort((a, b) => {
      const aExact = a.toLowerCase() === `${token.toLowerCase()}.json` ? 0 : 1;
      const bExact = b.toLowerCase() === `${token.toLowerCase()}.json` ? 0 : 1;
      return aExact - bExact || a.localeCompare(b);
    });
  return candidates.length ? join(directory, candidates[0]) : null;
}

async function prepareInputs(project, definition, runDir) {
  const inputsRoot = join(runDir, 'inputs');
  const sourceRoot = join(inputsRoot, 'source');
  const sourcePaths = [];
  const sourceRecords = project.sources ?? [];
  if (sourceRecords.length) {
    for (const source of sourceRecords) {
      const from = resolveInside(project.root, source.relativePath);
      const to = resolveInside(sourceRoot, source.filename);
      await copyTree(from, to);
      sourcePaths.push(to);
    }
  } else {
    try {
      const entries = await readdir(join(project.root, 'source'), { withFileTypes: true });
      for (const entry of entries.filter((item) => item.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
        const from = join(project.root, 'source', entry.name);
        const to = join(sourceRoot, entry.name);
        await copyTree(from, to);
        sourcePaths.push(to);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const upstream = {};
  const paths = [...sourcePaths];
  for (const stage of definition.upstreamStages ?? []) {
    const from = join(project.root, stage);
    const to = join(inputsRoot, 'upstream', stage);
    try {
      await lstat(from);
      await copyTree(from, to);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    paths.push(to);
    const token = STAGE_DEFINITIONS[stage]?.jsonToken ?? stage;
    const jsonPath = await readDirectJson(to, token);
    if (jsonPath) {
      upstream[stage] = jsonPath;
      paths.push(jsonPath);
    }
  }

  return {
    paths: [...new Set(paths)].sort(),
    sourcePaths,
    upstream,
  };
}

function sourceFile(sourcePaths) {
  return sourcePaths.find((path) => TEXT_EXTENSIONS.test(path)) ?? sourcePaths[0] ?? null;
}

function addIfPresent(args, flag, path) {
  if (path) args.push(flag, path);
  return args;
}

function validationArgs(type, jsonPath, inputs) {
  const args = ['validate', jsonPath];
  const book = sourceFile(inputs.sourcePaths);
  if (type === 'characters' && book) args.push(book);
  if (type === 'art') addIfPresent(args, '--cast', inputs.upstream.characters);
  if (type === 'script') {
    addIfPresent(args, '--outline', inputs.upstream.outline);
    addIfPresent(args, '--art', inputs.upstream.art);
  }
  if (type === 'storyboard') {
    addIfPresent(args, '--script', inputs.upstream.script);
    addIfPresent(args, '--outline', inputs.upstream.outline);
    addIfPresent(args, '--cast', inputs.upstream.characters);
    addIfPresent(args, '--art', inputs.upstream.art);
  }
  return { args };
}

function renderArgs(type, jsonPath, inputs) {
  const args = ['render', jsonPath];
  if (type === 'script') {
    addIfPresent(args, '--outline', inputs.upstream.outline);
    addIfPresent(args, '--art', inputs.upstream.art);
    addIfPresent(args, '--cast', inputs.upstream.characters);
  }
  if (type === 'storyboard') {
    addIfPresent(args, '--script', inputs.upstream.script);
    addIfPresent(args, '--outline', inputs.upstream.outline);
    addIfPresent(args, '--art', inputs.upstream.art);
  }
  return args;
}

async function command(nodeBin, args, cwd) {
  try {
    return await execFileAsync(nodeBin, args, {
      cwd,
      env: { ...process.env, NODE_OPTIONS: '' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = String(error.stderr ?? '').trim();
    const stdout = String(error.stdout ?? '').trim();
    const detail = [stderr, stdout].filter(Boolean).join('\n');
    throw new Error(`${error.message}${detail ? `\n${detail.slice(0, 6000)}` : ''}`);
  }
}

async function jsonArtifact(outputDir, definition) {
  const exact = join(outputDir, definition.artifactNames[0]);
  try {
    const info = await lstat(exact);
    if (info.isFile()) return exact;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const fallback = await readDirectJson(outputDir, definition.jsonToken);
  if (!fallback) throw new Error(`Missing ${definition.skillName} JSON output in ${outputDir}`);
  return fallback;
}

async function replaceDirectory(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await copyTree(source, destination);
}

function messageForCodexEvent(event) {
  if (typeof event?.message === 'string') return event.message;
  if (typeof event?.text === 'string') return event.text;
  if (typeof event?.item?.text === 'string') return event.item.text;
  return event?.type ?? 'Codex event';
}

function makeTimestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function createStageRunner({
  repoRoot,
  skillsRoot,
  skillLockPath = join(repoRoot, 'skills.lock.json'),
  projectStore,
  getTaskStore,
  codexBin = process.env.CODEX_BIN ?? 'codex',
  runCodexImpl = runCodex,
  snapshotSkillImpl = snapshotSkill,
  verifySkillLockImpl = verifySkillLock,
  hashSkillDirectoryImpl = hashSkillDirectory,
  renderAggregateReportImpl = renderAggregateReport,
  now = () => new Date().toISOString(),
} = {}) {
  if (!repoRoot || !skillsRoot || !projectStore || typeof getTaskStore !== 'function') {
    throw new TypeError('Stage runner needs repoRoot, skillsRoot, projectStore, and getTaskStore');
  }

  async function updateTask(store, taskId, patch) {
    try { return await store.update(taskId, patch); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  return async function runStageTask(task, { signal } = {}) {
    const definition = STAGE_DEFINITIONS[task.type];
    if (!definition || !definition.skillName) throw new Error(`Stage ${task.type} is not a Codex Skill stage`);
    const project = await projectStore.read(task.projectId);
    const store = await getTaskStore(project);
    const taskId = assertSafeId(task.id);
    const runDir = resolveInside(project.root, '.workbench', 'runs', taskId);
    const outputDir = join(runDir, 'output');
    const snapshotDestination = join(runDir, 'skill');
    const stageDir = resolveInside(project.root, definition.outputDirs[0]);
    const event = async (type, payload = {}) => store.appendEvent(taskId, {
      type,
      taskId,
      projectId: project.id,
      at: makeTimestamp(now),
      ...payload,
    });
    const setStageState = async (status, extra = {}) => {
      const current = await projectStore.read(project.id);
      await projectStore.update(project.id, {
        stageState: {
          ...(current.stageState ?? {}),
          [task.type]: {
            ...(current.stageState?.[task.type] ?? {}),
            status,
            taskId,
            skillName: definition.skillName,
            outputDir: relative(project.root, stageDir).split('\\').join('/'),
            ...extra,
          },
        },
      });
    };

    try {
      await rm(runDir, { recursive: true, force: true });
      await mkdir(outputDir, { recursive: true });
      await setStageState('running');

      const lockResult = await verifySkillLockImpl(skillLockPath, skillsRoot);
      if (!lockResult.ok) throw new Error(`Skill lock mismatch: ${lockResult.mismatches.join('; ')}`);
      const locked = lockResult.lock.skills?.[definition.skillName];
      if (!locked) throw new Error(`Skill is not present in lock: ${definition.skillName}`);
      const sourceSkillRoot = resolveInside(skillsRoot, definition.skillName);
      const beforeHash = await hashSkillDirectoryImpl(sourceSkillRoot);
      const snapshot = await snapshotSkillImpl({ skillsRoot, skillName: definition.skillName, destination: snapshotDestination });
      const snapshotMeta = {
        name: definition.skillName,
        version: locked.version,
        sha256: beforeHash.sha256,
        root: relative(project.root, snapshot.root).split('\\').join('/'),
      };
      await updateTask(store, taskId, { skillSnapshot: snapshotMeta, runDir: relative(project.root, runDir).split('\\').join('/') });
      await event('stage.snapshot', { status: 'running', skillSnapshot: snapshotMeta });

      const inputs = await prepareInputs(project, definition, runDir);
      const promptTask = {
        ...task,
        skillName: definition.skillName,
        outputDir: definition.outputDirs[0],
      };
      const prompt = buildSkillPrompt({
        task: promptTask,
        project,
        skillSnapshot: snapshot,
        inputPaths: inputs.paths,
        outputRoot: outputDir,
      });
      await writeFile(join(runDir, 'prompt.txt'), prompt, 'utf8');
      await event('stage.inputs', { status: 'running', inputPaths: inputs.paths.map((path) => relative(project.root, path).split('\\').join('/')) });

      const codexResult = await runCodexImpl({
        codexBin,
        cwd: runDir,
        prompt,
        signal,
        onEvent: (codexEvent) => event(`codex.${codexEvent.type ?? 'event'}`, {
          status: 'running',
          message: messageForCodexEvent(codexEvent),
          event: codexEvent,
        }),
        onStderr: (stderr) => event('codex.stderr', { status: 'running', message: String(stderr).slice(0, 8000) }),
      });
      await event('codex.completed', { status: 'running', result: codexResult });
      if (signal?.aborted) {
        const error = new Error('Stage task cancelled');
        error.name = 'AbortError';
        throw error;
      }
      if (codexResult.exitCode !== 0) throw new Error(`Codex exited with code ${codexResult.exitCode}`);

      const afterHash = await hashSkillDirectoryImpl(sourceSkillRoot);
      if (afterHash.sha256 !== beforeHash.sha256) throw new Error(`Skill changed during task: ${definition.skillName}`);

      const jsonPath = await jsonArtifact(outputDir, definition);
      JSON.parse(await readFile(jsonPath, 'utf8'));
      const validation = validationArgs(task.type, jsonPath, inputs);
      validation.script = join(snapshot.root, 'scripts', `${definition.skillName}.mjs`);
      await command(process.execPath, [validation.script, ...validation.args], outputDir)
        .catch((error) => { throw new Error(`${definition.skillName} validate failed: ${error.message}`); });
      await event('stage.validated', { status: 'running', jsonPath: relative(project.root, jsonPath).split('\\').join('/') });

      const markdownPath = join(outputDir, definition.reportName.replace(/\.html$/i, '.md'));
      const renderCommand = join(snapshot.root, 'scripts', `${definition.skillName}.mjs`);
      const markdown = await command(process.execPath, [renderCommand, ...renderArgs(task.type, jsonPath, inputs), '--md'], outputDir);
      await writeFile(markdownPath, markdown.stdout, 'utf8');
      const html = await command(process.execPath, [renderCommand, ...renderArgs(task.type, jsonPath, inputs), '--html'], outputDir);
      await writeFile(join(outputDir, definition.reportName), html.stdout, 'utf8');
      if (task.type === 'storyboard') {
        await command(process.execPath, [renderCommand, 'export', jsonPath, '--script', inputs.upstream.script, '--out', outputDir], outputDir);
      }
      await event('stage.rendered', { status: 'running', reportPath: relative(project.root, join(outputDir, definition.reportName)).split('\\').join('/') });

      const outputArtifacts = await indexArtifacts(outputDir);
      assertExpectedArtifacts(task.type, outputArtifacts.map((artifact) => ({
        ...artifact,
        relativePath: `${definition.outputDirs[0]}/${artifact.relativePath}`,
      })));
      await replaceDirectory(outputDir, stageDir);
      const aggregatePath = join(project.root, '.workbench', 'report.html');
      await renderAggregateReportImpl({ repoRoot, projectRoot: project.root, outputPath: aggregatePath });
      const allArtifacts = await indexArtifacts(project.root);
      const stagePrefix = `${definition.outputDirs[0]}/`;
      const artifactIds = allArtifacts
        .filter((artifact) => artifact.relativePath.startsWith(stagePrefix) || artifact.relativePath === '.workbench/report.html')
        .map((artifact) => artifact.relativePath);
      await updateTask(store, taskId, { artifactIds, finalMessage: codexResult.finalMessage ?? null });
      await setStageState('succeeded', { artifactIds });
      await event('stage.completed', { status: 'succeeded', artifactIds });
      return { status: 'succeeded', taskId, artifactIds, threadId: codexResult.threadId ?? null, finalMessage: codexResult.finalMessage ?? null };
    } catch (error) {
      const status = error?.name === 'AbortError' ? 'cancelled' : 'failed';
      await updateTask(store, taskId, { error: error instanceof Error ? error.message : String(error) });
      await setStageState(status, { error: error instanceof Error ? error.message : String(error) });
      await event(`stage.${status}`, { status, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}
