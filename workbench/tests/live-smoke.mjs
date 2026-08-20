import { copyFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectStore } from '../lib/project-store.mjs';
import { createTaskStore } from '../lib/task-store.mjs';
import { createImageRunner } from '../lib/image-runner.mjs';
import { loadProviderConfig } from '../lib/providers/provider-config.mjs';
import { compileMiniMaxH3 } from '../lib/providers/minimax-h3.mjs';
import { compileSeedance } from '../lib/providers/seedance.mjs';
import { submitVideoJob, pollVideoJob, downloadVideo } from '../lib/providers/video-runner.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export async function runCodexImageSmoke({ codexBin = process.env.CODEX_BIN ?? 'codex' } = {}) {
  const projectsRoot = await mkdtemp(join(tmpdir(), 'short-drama-live-image-'));
  const projectStore = createProjectStore({ projectsRoot });
  const project = await projectStore.create({ title: 'live-image-smoke' });
  await copyFile(join(repoRoot, 'skills/novel-characters/examples/渡口-cast.json'), join(project.root, 'characters/cast.json'));
  const store = createTaskStore(project.root);
  const task = await store.create({ id: 'live-image', projectId: project.id, type: 'image', ownerStage: 'characters', assetIds: ['沈知微'], options: { ownerStage: 'characters', assetIds: ['沈知微'] } });
  const runner = createImageRunner({
    repoRoot,
    skillsRoot: join(repoRoot, 'skills'),
    skillLockPath: join(repoRoot, 'skills.lock.json'),
    projectStore,
    getTaskStore: () => store,
    codexBin,
  });
  const result = await runner(task, { signal: new AbortController().signal });
  if (result.status !== 'succeeded') throw new Error(`Codex image smoke incomplete: ${result.status}`);
  return { ...result, projectRoot: project.root };
}

function smokeJob(frameUrl) {
  return {
    schemaVersion: '1.0',
    projectId: 'live-provider-smoke',
    episodeId: 'E01',
    segmentId: 'E01-01',
    durationSeconds: 6,
    ratio: '16:9',
    style: 'cinematic live-action',
    cuts: [{ index: 1, startSeconds: 0, endSeconds: 6, durationSeconds: 6, size: 'medium', camera: 'Static Shot', frame: 'A quiet person turns toward the camera in soft morning light.', characters: [], props: [], dialogue: [] }],
    dialogue: [],
    sound: { soundscape: 'soft room tone', music: '' },
    firstFramePath: 'storyboard/E01-01/f1.png',
    references: [{ kind: 'frame', assetId: 'frame-1', path: 'storyboard/E01-01/f1.png', url: frameUrl, role: 'first_frame', exists: true }],
    framePaths: ['storyboard/E01-01/f1.png'],
  };
}

export async function runProviderSmoke({ provider, frameUrl = process.env.VIDEO_SMOKE_FIRST_FRAME_URL, env = process.env } = {}) {
  if (!['minimax-h3', 'seedance'].includes(provider)) throw new Error('Provider smoke requires minimax-h3 or seedance');
  if (!/^https?:\/\//i.test(String(frameUrl ?? ''))) throw new Error('Set VIDEO_SMOKE_FIRST_FRAME_URL to a public HTTP image URL before provider smoke');
  const config = await loadProviderConfig(provider, { providersRoot: join(repoRoot, 'providers') });
  const job = smokeJob(frameUrl);
  const input = provider === 'minimax-h3' ? compileMiniMaxH3(job, config) : compileSeedance(job, config);
  const submitted = await submitVideoJob({ provider, input, env });
  const completed = await pollVideoJob({ provider, providerTaskId: submitted.providerTaskId, env, intervalMs: Number(env.VIDEO_SMOKE_POLL_MS ?? 2000) });
  if (!completed.videoUrl) throw new Error(`Provider smoke returned no downloadable URL; fileId=${completed.fileId ?? 'none'}`);
  const outputRoot = await mkdtemp(join(tmpdir(), `short-drama-live-${provider}-`));
  const outputPath = join(outputRoot, `${provider}.mp4`);
  const downloaded = await downloadVideo(completed.videoUrl, outputPath);
  return { provider, providerTaskId: submitted.providerTaskId, ...downloaded };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = new Set(process.argv.slice(2));
  const providerFlag = process.argv.indexOf('--provider');
  const provider = providerFlag >= 0 ? process.argv[providerFlag + 1] : null;
  if (!args.has('--codex') && !provider) {
    console.error('Usage: node workbench/tests/live-smoke.mjs --codex [--codex-bin <path>] | --provider <minimax-h3|seedance>');
    process.exitCode = 2;
  } else {
    try {
      if (args.has('--codex')) console.log(JSON.stringify(await runCodexImageSmoke({ codexBin: process.env.CODEX_BIN ?? 'codex' })));
      if (provider) console.log(JSON.stringify(await runProviderSmoke({ provider })));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
