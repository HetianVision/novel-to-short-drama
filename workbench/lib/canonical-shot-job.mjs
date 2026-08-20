import { lstat, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function slug(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'asset';
}

function episodeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function episodeId(value) {
  const number = Number(value);
  return Number.isInteger(number) ? `E${String(number).padStart(2, '0')}` : String(value ?? 'E01');
}

function projectRelativePath(projectRoot, relativePath) {
  const root = resolve(projectRoot);
  const candidate = resolve(root, relativePath);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.includes(`..${sep}`)) {
    throw new Error(`Reference path escapes project root: ${relativePath}`);
  }
  return rel.split(sep).join('/');
}

async function readJson(path, label, optional = false) {
  if (!path) {
    if (optional) return null;
    throw new Error(`Missing ${label} path`);
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error(`Invalid ${label} JSON: ${error.message}`);
    throw error;
  }
}

async function fileExists(path) {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function indexedId(prefix, index) {
  return `${prefix}${String(index + 1).padStart(2, '0')}`;
}

function byIdOrIndex(items, id, prefix) {
  const list = asArray(items);
  const direct = list.find((item) => String(item?.id ?? '') === String(id));
  if (direct) return direct;
  const match = /^([A-Za-z]+)(\d+)$/.exec(String(id ?? ''));
  if (match && match[1].toUpperCase() === prefix.toUpperCase()) {
    return list[Number(match[2]) - 1] ?? null;
  }
  return null;
}

function buildScriptBeats(scene) {
  return asArray(scene?.flow).map((beat, index) => ({
    n: index + 1,
    beatId: beat?.beatId ?? beat?.id ?? null,
    kind: typeof beat?.line === 'string' ? 'line' : 'action',
    speaker: typeof beat?.line === 'string' ? beat.speaker : undefined,
    delivery: typeof beat?.line === 'string' ? (beat.delivery ?? '') : undefined,
    text: typeof beat?.line === 'string' ? beat.line : (beat?.action ?? ''),
  }));
}

function dialogueForCut(cut, sceneBeats) {
  const [from, to] = Array.isArray(cut?.beats) ? cut.beats : [];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return [];
  return sceneBeats
    .slice(from - 1, to)
    .filter((beat) => beat.kind === 'line')
    .map((beat) => ({ speaker: beat.speaker ?? 'VO', line: beat.text, delivery: beat.delivery ?? '' }));
}

function imagePath(stage, label) {
  return `${stage}/images/${slug(label)}-sheet.png`;
}

function reference({ kind, assetId, name, path, role, exists, description }) {
  return {
    kind,
    assetId: String(assetId),
    ...(name ? { name: String(name) } : {}),
    path,
    ...(role ? { role } : {}),
    exists: Boolean(exists),
    ...(description ? { description: String(description) } : {}),
  };
}

function uniqueReferences(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.kind}:${item.assetId}:${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getSound(segment, scene) {
  return {
    soundscape: String(segment?.soundscape ?? segment?.overallSoundscape ?? scene?.soundscape ?? ''),
    music: String(segment?.music ?? segment?.nonDiegeticMusic ?? scene?.music ?? ''),
  };
}

async function buildJob({ projectRoot, projectId, storyboard, script, cast, art, ep, segment, options = {} }) {
  const root = resolve(projectRoot);
  const epNo = episodeNumber(ep?.ep);
  const scriptEpisode = asArray(script?.episodes).find((item) => episodeNumber(item?.ep) === epNo);
  const scriptScenes = asArray(scriptEpisode?.scenes);
  const sceneIndex = Number(segment?.sceneIndex);
  const scene = Number.isInteger(sceneIndex) && sceneIndex > 0 ? (scriptScenes[sceneIndex - 1] ?? null) : null;
  const sceneId = scene?.sceneId ?? segment?.sceneId ?? null;
  const sceneAsset = sceneId ? byIdOrIndex(art?.scenes, sceneId, 'S') : null;
  const sceneName = sceneAsset?.name ?? sceneId ?? '';
  const scenePath = sceneId ? projectRelativePath(root, imagePath('art', sceneName || sceneId)) : null;
  const sceneExists = scenePath ? await fileExists(join(root, scenePath)) : false;

  const cuts = asArray(segment?.cuts).map((cut, index) => {
    const startSeconds = asArray(segment?.cuts).slice(0, index).reduce((sum, item) => sum + Number(item?.seconds ?? 0), 0);
    const durationSeconds = Number(cut?.seconds ?? 0);
    const characterIds = asArray(cut?.characters).map(String);
    const propIds = asArray(cut?.props).map(String);
    return {
      index: index + 1,
      startSeconds,
      endSeconds: startSeconds + durationSeconds,
      durationSeconds,
      size: String(cut?.size ?? ''),
      camera: String(cut?.camera ?? ''),
      frame: String(cut?.frame ?? cut?.imagePrompt ?? cut?.prompt ?? ''),
      characters: characterIds,
      props: propIds,
      dialogue: dialogueForCut(cut, buildScriptBeats(scene)),
      ...(cut?.recipe ? { recipe: String(cut.recipe) } : {}),
    };
  });

  const assetReferences = [];
  if (sceneId) {
    assetReferences.push(reference({
      kind: 'scene', assetId: sceneId, name: sceneName, path: scenePath, exists: sceneExists,
      description: sceneAsset?.summary ?? sceneAsset?.usage ?? sceneName,
    }));
  }

  const charIds = [...new Set(cuts.flatMap((cut) => cut.characters))];
  for (const assetId of charIds) {
    const index = Number(String(assetId).match(/\d+$/)?.[0] ?? 0) - 1;
    const character = byIdOrIndex(cast?.characters, assetId, 'C') ?? asArray(cast?.characters)[index] ?? null;
    const name = character?.name ?? assetId;
    const path = projectRelativePath(root, imagePath('characters', name));
    assetReferences.push(reference({
      kind: 'character', assetId, name, path, exists: await fileExists(join(root, path)),
      description: character?.oneLiner ?? character?.persona?.identity ?? name,
    }));
  }

  const propIds = [...new Set(cuts.flatMap((cut) => cut.props))];
  for (const assetId of propIds) {
    const prop = byIdOrIndex(art?.props ?? art?.properties, assetId, 'P');
    const name = prop?.name ?? assetId;
    const path = projectRelativePath(root, imagePath('art', name));
    assetReferences.push(reference({
      kind: 'prop', assetId, name, path, exists: await fileExists(join(root, path)),
      description: prop?.summary ?? prop?.function ?? name,
    }));
  }

  const frameReferences = cuts.map((cut) => {
    const path = projectRelativePath(root, `storyboard/${segment.id}/f${cut.index}.png`);
    return reference({
      kind: 'frame',
      assetId: `${segment.id}#${cut.index}`,
      name: `Picture ${cut.index}`,
      path,
      role: cut.index === 1 ? 'first_frame' : (cut.index === cuts.length ? 'last_frame' : 'frame'),
      exists: false,
      description: cut.frame,
    });
  });
  for (const item of frameReferences) item.exists = await fileExists(join(root, item.path));

  const references = uniqueReferences([...assetReferences, ...frameReferences]);
  const durationSeconds = cuts.reduce((sum, cut) => sum + cut.durationSeconds, 0);
  const dialogue = cuts.flatMap((cut) => cut.dialogue);
  const jobId = String(projectId ?? basename(root));
  return {
    schemaVersion: '1.0',
    projectId: jobId,
    source: storyboard?.source ?? script?.source ?? cast?.source ?? art?.source ?? '',
    episodeId: episodeId(ep?.ep),
    episodeNumber: epNo,
    segmentId: String(segment?.id ?? `${episodeId(ep?.ep)}-01`),
    sceneIndex: Number.isInteger(sceneIndex) ? sceneIndex : null,
    sceneId,
    duration: durationSeconds,
    durationSeconds,
    ratio: options.ratio ?? storyboard?.ratio ?? '16:9',
    style: options.style ?? art?.style ?? cast?.style ?? 'cinematic live-action',
    cuts,
    dialogue,
    sound: getSound(segment, scene),
    framePaths: frameReferences.map((item) => item.path),
    firstFramePath: frameReferences[0]?.path ?? null,
    lastFramePath: frameReferences.length > 1 ? frameReferences.at(-1).path : null,
    references,
    missingReferences: references.filter((item) => !item.exists).map((item) => ({ ...item })),
  };
}

export async function buildCanonicalShotJobs({ projectRoot, projectId, storyboardPath, castPath, artPath, scriptPath, options = {} } = {}) {
  if (!projectRoot) throw new TypeError('projectRoot is required');
  const [storyboard, cast, art, script] = await Promise.all([
    readJson(storyboardPath, 'storyboard'),
    readJson(castPath, 'cast', true),
    readJson(artPath, 'art', true),
    readJson(scriptPath, 'script', false),
  ]);
  const jobs = [];
  for (const ep of asArray(storyboard?.episodes)) {
    for (const segment of asArray(ep?.segments)) {
      jobs.push(await buildJob({ projectRoot, projectId, storyboard, script, cast, art, ep, segment, options }));
    }
  }
  if (!jobs.length) throw new Error('Storyboard contains no segments');
  return jobs;
}

export async function buildCanonicalShotJob(args = {}) {
  const jobs = await buildCanonicalShotJobs(args);
  if (jobs.length !== 1) throw new Error(`Expected one storyboard segment, found ${jobs.length}`);
  return jobs[0];
}
