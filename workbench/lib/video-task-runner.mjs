import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { assertSafeId, resolveInside } from './path-utils.mjs';
import { buildCanonicalShotJobs } from './canonical-shot-job.mjs';
import { loadProviderConfig } from './providers/provider-config.mjs';
import { compileMiniMaxH3 } from './providers/minimax-h3.mjs';
import { compileSeedance } from './providers/seedance.mjs';
import { submitVideoJob, pollVideoJob, downloadVideo, sanitizeProviderMetadata } from './providers/video-runner.mjs';
import { indexArtifacts } from './artifact-index.mjs';
import { renderAggregateReport } from './report-runner.mjs';

const PROVIDERS = new Set(['minimax-h3', 'seedance']);

async function directJson(directory, token) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !/manifest|\.gates/i.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().includes(token.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  return candidates.length ? join(directory, candidates[0]) : null;
}

function rel(projectRoot, path) {
  return relative(projectRoot, path).split('\\').join('/');
}

function defaultAssetResolver({ env, task }) {
  const base = task.options?.assetBaseUrl ?? env.VIDEO_ASSET_BASE_URL;
  if (!base) return null;
  return async (assetReference) => {
    const path = String(assetReference).slice('asset://'.length).split('/').map(encodeURIComponent).join('/');
    return `${String(base).replace(/\/$/, '')}/${path}`;
  };
}

export function buildVideoTask({ projectId, provider, options = {} } = {}) {
  if (!PROVIDERS.has(provider)) throw new Error(`Unknown video provider: ${provider}`);
  return {
    projectId,
    type: 'video',
    provider,
    options: { ...options, provider },
    outputDir: 'video',
  };
}

export function createVideoRunner({
  repoRoot,
  projectStore,
  getTaskStore,
  loadProviderConfigImpl = loadProviderConfig,
  compileMiniMaxH3Impl = compileMiniMaxH3,
  compileSeedanceImpl = compileSeedance,
  submitVideoJobImpl = submitVideoJob,
  pollVideoJobImpl = pollVideoJob,
  downloadVideoImpl = downloadVideo,
  renderAggregateReportImpl = renderAggregateReport,
  fetchImpl = globalThis.fetch,
  downloadFetchImpl = fetchImpl,
  env = process.env,
  assetResolver = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!repoRoot || !projectStore || typeof getTaskStore !== 'function') throw new TypeError('Video runner needs repoRoot, projectStore, and getTaskStore');

  return async function runVideoTask(task, { signal } = {}) {
    if (task.type !== 'video') throw new Error(`Unsupported video task type: ${task.type}`);
    const provider = task.provider ?? task.options?.provider;
    if (!PROVIDERS.has(provider)) throw new Error(`Unknown video provider: ${provider}`);
    const project = await projectStore.read(task.projectId);
    const store = await getTaskStore(project);
    const taskId = assertSafeId(task.id);
    const runDir = resolveInside(project.root, '.workbench', 'runs', taskId);
    const event = async (type, payload = {}) => store.appendEvent(taskId, {
      type, taskId, projectId: project.id, at: typeof now === 'function' ? now() : now, ...payload,
    });
    const setVideoState = async (status, extra = {}) => {
      const latest = await projectStore.read(project.id);
      await projectStore.update(project.id, {
        stageState: {
          ...(latest.stageState ?? {}),
          video: {
            ...(latest.stageState?.video ?? {}),
            status, taskId, provider, outputDir: 'video', ...extra,
          },
        },
      });
    };

    try {
      await rm(runDir, { recursive: true, force: true });
      await mkdir(runDir, { recursive: true });
      await setVideoState('running');
      const storyboardPath = await directJson(join(project.root, 'storyboard'), 'storyboard');
      const scriptPath = await directJson(join(project.root, 'script'), 'script');
      const castPath = await directJson(join(project.root, 'characters'), 'cast');
      const artPath = await directJson(join(project.root, 'art'), 'art');
      if (!storyboardPath || !scriptPath) throw new Error('Video task needs storyboard.json and script.json');
      const jobs = await buildCanonicalShotJobs({ projectRoot: project.root, projectId: project.id, storyboardPath, castPath, artPath, scriptPath, options: task.options });
      const requested = task.options?.segmentIds?.length
        ? new Set(task.options.segmentIds.map(String))
        : task.options?.segmentId ? new Set([String(task.options.segmentId)]) : null;
      const selected = requested ? jobs.filter((job) => requested.has(job.segmentId)) : jobs;
      if (!selected.length) throw new Error('No requested storyboard segment exists');
      const config = await loadProviderConfigImpl(provider, { providersRoot: join(repoRoot, 'providers') });
      const results = [];
      const failures = [];
      const resolveAsset = assetResolver ?? defaultAssetResolver({ env, task });

      for (const job of selected) {
        if (signal?.aborted) { const error = new Error('Video task cancelled'); error.name = 'AbortError'; throw error; }
        if (job.missingReferences.some((item) => item.kind === 'frame' && item.path === job.firstFramePath)) {
          throw new Error(`Missing first storyboard frame for ${job.segmentId}; generate storyboard images before video`);
        }
        const input = provider === 'minimax-h3'
          ? compileMiniMaxH3Impl(job, config, task.options)
          : compileSeedanceImpl(job, config, task.options);
        const inputPath = resolveInside(runDir, `${job.segmentId}.input.json`);
        await writeFile(inputPath, `${JSON.stringify(sanitizeProviderMetadata({ job, input }), null, 2)}\n`, 'utf8');
        await event('video.compiled', {
          status: 'running', provider, segmentId: job.segmentId,
          inputPath: rel(project.root, inputPath), promptLength: input.content?.find((item) => item.type === 'text')?.text?.length ?? 0,
          referenceCount: input.content?.filter((item) => item.type === 'image_url').length ?? 0,
        });
        try {
          const submitted = await submitVideoJobImpl({
            provider,
            input,
            fetchImpl,
            env,
            requestPolicy: config.requestPolicy,
            assetResolver: resolveAsset,
          });
          await event('video.submitted', { status: 'running', provider, segmentId: job.segmentId, providerTaskId: submitted.providerTaskId });
          const polled = await pollVideoJobImpl({
            provider,
            providerTaskId: submitted.providerTaskId,
            fetchImpl,
            env,
            requestPolicy: config.requestPolicy,
            signal,
            onStatus: (statusEvent) => { void event('video.status', { ...statusEvent, status: 'running', segmentId: job.segmentId }); },
          });
          if (!polled.videoUrl) throw new Error(`Provider ${provider} returned no downloadable video URL for ${job.segmentId}`);
          const outputPath = resolveInside(project.root, 'video', `${job.segmentId}-${provider}.mp4`);
          const downloaded = await downloadVideoImpl(polled.videoUrl, outputPath, downloadFetchImpl);
          const result = { segmentId: job.segmentId, provider, providerTaskId: submitted.providerTaskId, ...downloaded, fileId: polled.fileId ?? null };
          results.push(result);
          await event('video.downloaded', { status: 'running', ...result, path: rel(project.root, outputPath), metadata: sanitizeProviderMetadata(polled.metadata) });
        } catch (error) {
          if (error?.name === 'AbortError' || signal?.aborted) throw error;
          const failure = { segmentId: job.segmentId, error: error instanceof Error ? error.message : String(error) };
          failures.push(failure);
          await event('video.segment-failed', { status: 'running', provider, ...failure });
        }
      }

      if (!results.length) throw new Error(`Video generation failed: ${failures.map((item) => `${item.segmentId}: ${item.error}`).join('; ')}`);
      await renderAggregateReportImpl({ repoRoot, projectRoot: project.root, outputPath: join(project.root, '.workbench', 'report.html') });
      const artifacts = await indexArtifacts(project.root);
      const artifactIds = artifacts.filter((artifact) => artifact.type === 'video' || artifact.relativePath === '.workbench/report.html').map((artifact) => artifact.relativePath);
      const status = failures.length ? 'partial' : 'succeeded';
      await store.update(taskId, { provider, videoJobs: results, failures, artifactIds });
      await setVideoState(status, { artifactIds, failures: failures.length ? failures : undefined });
      await event(`video.${status}`, { status, provider, artifactIds, results, failures });
      return { status, taskId, provider, artifactIds, results, failures };
    } catch (error) {
      const status = error?.name === 'AbortError' ? 'cancelled' : 'failed';
      try { await store.update(taskId, { error: error instanceof Error ? error.message : String(error) }); } catch (updateError) { if (updateError.code !== 'ENOENT') throw updateError; }
      await setVideoState(status, { error: error instanceof Error ? error.message : String(error) });
      await event(`video.${status}`, { status, provider, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}
