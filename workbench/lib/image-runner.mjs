import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { assertSafeId, resolveInside } from './path-utils.mjs';
import { IMAGE_OWNER_STAGES, STAGE_DEFINITIONS } from './task-definitions.mjs';
import { snapshotSkill, verifySkillLock, hashSkillDirectory } from './skill-lock.mjs';
import { runCodex } from './codex-runner.mjs';
import { indexArtifacts } from './artifact-index.mjs';
import { renderAggregateReport } from './report-runner.mjs';

const execFileAsync = promisify(execFile);
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

function slug(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'asset';
}

function normalizeTarget(ownerStage, value) {
  const raw = String(value ?? '').trim().replaceAll('\\', '/');
  if (!raw || raw.startsWith('/') || raw.split('/').includes('..')) throw new Error(`Unsafe image target: ${value}`);
  if (ownerStage === 'storyboard') {
    const target = IMAGE_EXT.test(raw) ? raw : `${raw}.png`;
    if (!/^[^/]+\/f\d+\.png$/i.test(target)) throw new Error(`Storyboard image target must look like E01-01/f1.png: ${value}`);
    return target;
  }
  const target = raw.startsWith('images/') ? raw : `images/${raw}`;
  const withExtension = IMAGE_EXT.test(target) ? target : `${target}.png`;
  if (!withExtension.startsWith('images/')) throw new Error(`Image target must stay under images/: ${value}`);
  return withExtension;
}

export function buildImageTask({ projectId, ownerStage, assetIds = [], options = {} } = {}) {
  if (!IMAGE_OWNER_STAGES.includes(ownerStage)) throw new Error(`Unknown image owner stage: ${ownerStage}`);
  const definition = STAGE_DEFINITIONS[ownerStage];
  return {
    projectId,
    type: 'image',
    ownerStage,
    assetIds: [...assetIds].map((value) => String(value)),
    options,
    skillName: definition.skillName,
    outputDir: ownerStage,
  };
}

export function classifyImageResult({ requested = [], present = [], promptFiles = [], processExitCode = 0 } = {}) {
  const wanted = [...new Set(requested.map(String))];
  const found = [...new Set(present.map(String))];
  const missing = wanted.filter((id) => !found.includes(id));
  if (!wanted.length) return { status: 'failed', missing: [], present: found, promptFiles: [...promptFiles] };
  if (processExitCode !== 0 && !found.length) return { status: 'failed', missing, present: found, promptFiles: [...promptFiles] };
  if (!missing.length && processExitCode === 0) return { status: 'succeeded', missing: [], present: found, promptFiles: [...promptFiles] };
  if (found.length || promptFiles.length) return { status: 'partial', missing, present: found, promptFiles: [...promptFiles] };
  return { status: 'failed', missing, present: found, promptFiles: [...promptFiles] };
}

async function copyTree(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Symbolic link is not allowed in image input: ${source}`);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      await copyTree(join(source, entry.name), join(destination, entry.name));
    }
    return;
  }
  if (!info.isFile()) throw new Error(`Unsupported image input: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function directJson(directory, token) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !/manifest|\.gates/i.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().includes(token.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  return files.length ? join(directory, files[0]) : null;
}

export function targetsFromDocument(ownerStage, document) {
  if (ownerStage === 'characters') {
    return (document.characters ?? []).map((character) => ({
      id: character.id ?? character.name,
      relativePath: normalizeTarget(ownerStage, `${slug(character.name ?? character.id)}-sheet.png`),
      description: character.image?.sheet ?? character.oneLiner ?? character.name ?? character.id,
    }));
  }
  if (ownerStage === 'art') {
    const scenes = (document.scenes ?? []).map((scene) => ({
      id: scene.id ?? scene.name,
      relativePath: normalizeTarget(ownerStage, `${slug(scene.name ?? scene.id)}-sheet.png`),
      description: scene.image?.sheet ?? scene.prompt ?? scene.name ?? scene.id,
    }));
    const props = (document.props ?? document.properties ?? []).map((prop) => ({
      id: prop.id ?? prop.name,
      relativePath: normalizeTarget(ownerStage, `${slug(prop.name ?? prop.id)}-sheet.png`),
      description: prop.image?.sheet ?? prop.prompt ?? prop.name ?? prop.id,
    }));
    return [...scenes, ...props];
  }
  return (document.episodes ?? []).flatMap((episode) => (episode.segments ?? []).flatMap((segment) => (segment.cuts ?? []).map((cut, index) => ({
    id: `${segment.id ?? 'segment'}#${index + 1}`,
    relativePath: normalizeTarget(ownerStage, `${segment.id ?? 'segment'}/f${index + 1}.png`),
    description: cut.frame ?? cut.imagePrompt ?? cut.prompt ?? `${segment.id} cut ${index + 1}`,
  }))));
}

async function resolveTargets(project, task) {
  const ownerRoot = join(project.root, task.ownerStage);
  const definition = STAGE_DEFINITIONS[task.ownerStage];
  const jsonPath = await directJson(ownerRoot, definition.jsonToken);
  if (!jsonPath) throw new Error(`Missing ${task.ownerStage} JSON before image generation`);
  const document = JSON.parse(await readFile(jsonPath, 'utf8'));
  const available = targetsFromDocument(task.ownerStage, document);
  if (!task.assetIds?.length) return { jsonPath, targets: available };
  const byId = new Map(available.map((target) => [String(target.id), target]));
  return {
    jsonPath,
    targets: task.assetIds.map((assetId) => byId.get(String(assetId)) ?? {
      id: assetId,
      relativePath: normalizeTarget(task.ownerStage, assetId),
      description: assetId,
    }),
  };
}

function imageReferenceDoc(ownerStage, skillRoot) {
  const reference = ownerStage === 'characters' ? 'sheet.md' : ownerStage === 'art' ? 'sheet.md' : 'frame.md';
  return join(skillRoot, 'references', reference);
}

export function buildImagePrompt({ task, project, ownerSkillRoot, outputRoot, ownerJsonPath, target, inputPaths = [] }) {
  const outputPath = resolveInside(outputRoot, target.relativePath);
  return [
    `You are generating one ${task.ownerStage} image asset for project ${project.id}.`,
    '',
    `Read the read-only Skill instructions at ${join(ownerSkillRoot, 'SKILL.md')}.`,
    `Read the image-generation contract at ${imageReferenceDoc(task.ownerStage, ownerSkillRoot)}.`,
    `Read the owning JSON at ${ownerJsonPath}.`,
    'Reference inputs available to this task:',
    ...(inputPaths.length ? inputPaths.map((path) => `- ${path}`) : ['- none']),
    '',
    `Asset id: ${target.id}`,
    `Asset description: ${target.description ?? target.id}`,
    `Use the owning Skill image.sheet or frame contract exactly; do not invent a new layout.`,
    'Use the Codex built-in $imagegen capability. Generate exactly this one asset in this task.',
    `Copy the final selected PNG to ${outputPath}.`,
    'Do not return base64 or a markdown preview. Return only the output path after the file exists.',
    `Do not modify the repository skills/ directory or the read-only Skill snapshot.`,
    `Write only the requested image under ${outputRoot}.`,
    task.options?.prompt ? `Additional user direction: ${task.options.prompt}` : '',
  ].filter(Boolean).join('\n');
}

async function command(nodeBin, args, cwd) {
  try {
    return await execFileAsync(nodeBin, args, { cwd, env: { ...process.env, NODE_OPTIONS: '' }, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const detail = [error.stderr, error.stdout].filter(Boolean).join('\n').slice(0, 6000);
    throw new Error(`${error.message}${detail ? `\n${detail}` : ''}`);
  }
}

async function fileExists(path) {
  try { return (await lstat(path)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function renderOwnerReport({ project, ownerStage, jsonPath, skillRoot }) {
  const definition = STAGE_DEFINITIONS[ownerStage];
  const ownerRoot = join(project.root, ownerStage);
  const script = join(skillRoot, 'scripts', `${definition.skillName}.mjs`);
  const args = ['render', jsonPath];
  if (ownerStage === 'storyboard') {
    const scriptJson = await directJson(join(project.root, 'script'), 'script');
    if (!scriptJson) throw new Error('Cannot refresh storyboard report without script.json');
    args.push('--script', scriptJson);
  }
  if (ownerStage === 'script') {
    const outline = await directJson(join(project.root, 'outline'), 'outline');
    const art = await directJson(join(project.root, 'art'), 'art');
    if (outline) args.push('--outline', outline);
    if (art) args.push('--art', art);
  }
  if (ownerStage === 'art') {
    const cast = await directJson(join(project.root, 'characters'), 'cast');
    if (cast) args.push('--cast', cast);
  }
  const markdown = await command(process.execPath, [script, ...args, '--md'], ownerRoot);
  await writeFile(join(ownerRoot, definition.reportName.replace(/\.html$/i, '.md')), markdown.stdout, 'utf8');
  const html = await command(process.execPath, [script, ...args, '--html'], ownerRoot);
  await writeFile(join(ownerRoot, definition.reportName), html.stdout, 'utf8');
}

export function createImageRunner({
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
  if (!repoRoot || !skillsRoot || !projectStore || typeof getTaskStore !== 'function') throw new TypeError('Image runner needs repoRoot, skillsRoot, projectStore, and getTaskStore');

  return async function runImageTask(task, { signal } = {}) {
    const ownerStage = task.ownerStage ?? task.options?.ownerStage;
    if (!IMAGE_OWNER_STAGES.includes(ownerStage)) throw new Error(`Unknown image owner stage: ${ownerStage}`);
    const definition = STAGE_DEFINITIONS[ownerStage];
    const project = await projectStore.read(task.projectId);
    const store = await getTaskStore(project);
    const taskId = assertSafeId(task.id);
    const runDir = resolveInside(project.root, '.workbench', 'runs', taskId);
    const outputRoot = join(runDir, 'output');
    const snapshotDestination = join(runDir, 'skill');
    const ownerRoot = resolveInside(project.root, ownerStage);
    const emit = (type, payload = {}) => store.appendEvent(taskId, {
      type, taskId, projectId: project.id, at: typeof now === 'function' ? now() : now, ...payload,
    });
    try {
      await rm(runDir, { recursive: true, force: true });
      await mkdir(outputRoot, { recursive: true });
      const lock = await verifySkillLockImpl(skillLockPath, skillsRoot);
      if (!lock.ok) throw new Error(`Skill lock mismatch: ${lock.mismatches.join('; ')}`);
      const locked = lock.lock.skills?.[definition.skillName];
      if (!locked) throw new Error(`Skill is not present in lock: ${definition.skillName}`);
      const sourceSkillRoot = resolveInside(skillsRoot, definition.skillName);
      const beforeHash = await hashSkillDirectoryImpl(sourceSkillRoot);
      const snapshot = await snapshotSkillImpl({ skillsRoot, skillName: definition.skillName, destination: snapshotDestination });
      const ownerJson = await resolveTargets(project, { ...task, ownerStage });
      const ownerInputRoot = join(runDir, 'inputs', ownerStage);
      await copyTree(ownerRoot, ownerInputRoot);
      const inputPaths = [ownerInputRoot, ownerJson.jsonPath];
      if (ownerStage === 'storyboard') {
        for (const stage of ['art', 'characters']) {
          const source = join(project.root, stage);
          const destination = join(runDir, 'inputs', stage);
          try { await copyTree(source, destination); inputPaths.push(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      const requested = ownerJson.targets.map((target) => String(target.id));
      if (!requested.length) throw new Error(`No image targets found in ${ownerStage} JSON`);
      await emit('image.targets', { status: 'running', ownerStage, requested });
      const present = [];
      const promptFiles = [];
      const failures = [];
      for (const target of ownerJson.targets) {
        if (signal?.aborted) { const error = new Error('Image task cancelled'); error.name = 'AbortError'; throw error; }
        const prompt = buildImagePrompt({
          task: { ...task, ownerStage },
          project,
          ownerSkillRoot: snapshot.root,
          outputRoot,
          ownerJsonPath: ownerJson.jsonPath,
          target,
          inputPaths,
        });
        const promptPath = join(runDir, 'prompts', `${slug(target.id)}.prompt.md`);
        await mkdir(dirname(promptPath), { recursive: true });
        await writeFile(promptPath, prompt, 'utf8');
        promptFiles.push(relative(project.root, promptPath).split('\\').join('/'));
        await emit('image.started', { status: 'running', assetId: target.id, targetPath: target.relativePath });
        try {
          const result = await runCodexImpl({
            codexBin,
            cwd: runDir,
            prompt,
            signal,
            onEvent: (codexEvent) => emit(`codex.${codexEvent.type ?? 'event'}`, { status: 'running', assetId: target.id, event: codexEvent }),
            onStderr: (stderr) => emit('codex.stderr', { status: 'running', assetId: target.id, message: String(stderr).slice(0, 8000) }),
          });
          const outputPath = resolveInside(outputRoot, target.relativePath);
          if (result.exitCode !== 0 || !(await fileExists(outputPath))) {
            failures.push({ assetId: target.id, error: result.exitCode !== 0 ? `Codex exited with code ${result.exitCode}` : 'PNG output is missing' });
            continue;
          }
          present.push(String(target.id));
          const destination = resolveInside(ownerRoot, target.relativePath);
          await mkdir(dirname(destination), { recursive: true });
          await copyFile(outputPath, destination);
          await emit('image.completed', { status: 'running', assetId: target.id, targetPath: relative(project.root, destination).split('\\').join('/') });
        } catch (error) {
          if (error?.name === 'AbortError' || signal?.aborted) throw error;
          failures.push({ assetId: target.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const afterHash = await hashSkillDirectoryImpl(sourceSkillRoot);
      if (afterHash.sha256 !== beforeHash.sha256) throw new Error(`Skill changed during image task: ${definition.skillName}`);
      const classification = classifyImageResult({ requested, present, promptFiles, processExitCode: failures.length ? 1 : 0 });
      if (classification.status === 'failed') throw new Error(`Image generation failed: ${failures.map((item) => `${item.assetId}: ${item.error}`).join('; ') || 'no image output'}`);
      await renderOwnerReport({ project, ownerStage, jsonPath: ownerJson.jsonPath, skillRoot: snapshot.root });
      await renderAggregateReportImpl({ repoRoot, projectRoot: project.root, outputPath: join(project.root, '.workbench', 'report.html') });
      const allArtifacts = await indexArtifacts(project.root);
      const prefix = `${ownerStage}/`;
      const artifactIds = allArtifacts.filter((artifact) => artifact.relativePath.startsWith(prefix) || artifact.relativePath === '.workbench/report.html').map((artifact) => artifact.relativePath);
      await store.update(taskId, { artifactIds, imageResult: { ...classification, failures } });
      await emit(`image.${classification.status}`, { status: classification.status, ownerStage, result: { ...classification, failures }, artifactIds });
      return { status: classification.status, taskId, ownerStage, artifactIds, imageResult: { ...classification, failures } };
    } catch (error) {
      const status = error?.name === 'AbortError' ? 'cancelled' : 'failed';
      try { await store.update(taskId, { error: error instanceof Error ? error.message : String(error) }); } catch (updateError) { if (updateError.code !== 'ENOENT') throw updateError; }
      await emit(`image.${status}`, { status, ownerStage, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}
