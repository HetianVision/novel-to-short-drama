import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_REQUESTS = Object.freeze({
  'minimax-h3': {
    endpoint: 'https://api.minimaxi.com/v1/video_generation',
    queryEndpoint: 'https://api.minimaxi.com/v1/query/video_generation',
    fileEndpoint: 'https://api.minimaxi.com/v1/files/retrieve',
    apiKeyEnv: 'MINIMAX_API_KEY',
  },
  seedance: {
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
    queryEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
    apiKeyEnv: 'ARK_API_KEY',
  },
});

function assertProvider(provider) {
  if (!DEFAULT_REQUESTS[provider]) throw new Error(`Unknown video provider: ${provider}`);
}

function policyFor(provider, requestPolicy) {
  assertProvider(provider);
  return { ...DEFAULT_REQUESTS[provider], ...(requestPolicy ?? {}) };
}

function sanitize(value, key = '') {
  if (value == null) return value;
  if (/(authorization|api[_-]?key|access[_-]?token|secret|password)/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  }
  return value;
}

async function readResponse(response) {
  try {
    return await response.json();
  } catch {
    try { return { message: await response.text() }; } catch { return {}; }
  }
}

async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const body = await readResponse(response);
  if (!response.ok) {
    const detail = sanitize(body?.error?.message ?? body?.message ?? body);
    throw new Error(`Provider HTTP ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return body;
}

function apiKeyFor(provider, policy, env) {
  const source = env ?? process.env;
  const value = source[policy.apiKeyEnv];
  if (!value) throw new Error(`${provider} API key is missing from ${policy.apiKeyEnv}`);
  return String(value);
}

async function resolveAssets(value, assetResolver, context) {
  if (typeof value === 'string' && value.startsWith('asset://')) {
    if (typeof assetResolver !== 'function') throw new Error(`Asset URL resolver is required for ${value}`);
    const resolved = await assetResolver(value, context);
    if (!resolved || !/^https?:\/\//i.test(String(resolved))) throw new Error(`Asset resolver returned a non-HTTP URL for ${value}`);
    return String(resolved);
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveAssets(item, assetResolver, context)));
  if (value && typeof value === 'object') {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveAssets(item, assetResolver, context)])));
  }
  return value;
}

function taskIdFrom(provider, body) {
  const id = provider === 'minimax-h3'
    ? (body?.task_id ?? body?.data?.task_id ?? body?.id ?? body?.data?.id)
    : (body?.id ?? body?.data?.id ?? body?.task_id ?? body?.data?.task_id);
  if (!id) throw new Error(`Provider ${provider} did not return a task id`);
  return String(id);
}

function statusFrom(provider, body) {
  const raw = body?.status ?? body?.data?.status ?? body?.task_status ?? body?.data?.task_status ?? body?.state;
  const status = String(raw ?? '').toLowerCase();
  if (['success', 'succeeded', 'completed', 'complete', 'done'].includes(status)) return 'succeeded';
  if (['fail', 'failed', 'error', 'expired', 'cancelled', 'canceled'].includes(status)) return status === 'cancelled' || status === 'canceled' ? 'cancelled' : 'failed';
  if (provider === 'seedance' && status === 'queued') return 'running';
  if (body?.video_url || body?.data?.video_url || body?.content?.video_url || body?.data?.content?.video_url) return 'succeeded';
  return 'running';
}

function videoUrlFrom(body) {
  return body?.video_url
    ?? body?.data?.video_url
    ?? body?.content?.video_url
    ?? body?.data?.content?.video_url
    ?? body?.file?.download_url
    ?? body?.data?.file?.download_url
    ?? null;
}

async function retrieveMiniMaxFile({ fileId, policy, fetchImpl, apiKey }) {
  if (!fileId) return null;
  const separator = policy.fileEndpoint.includes('?') ? '&' : '?';
  const body = await requestJson(fetchImpl, `${policy.fileEndpoint}${separator}file_id=${encodeURIComponent(fileId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}` },
  });
  return {
    url: body?.file?.download_url ?? body?.data?.file?.download_url ?? null,
    metadata: sanitize(body),
  };
}

function errorFrom(body) {
  const value = body?.error?.message
    ?? body?.data?.error?.message
    ?? body?.message
    ?? body?.data?.message
    ?? body?.error
    ?? 'unknown provider error';
  return String(sanitize(value));
}

function authHeaders(apiKey) {
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
}

export async function submitVideoJob({ provider, input, fetchImpl = globalThis.fetch, env = process.env, requestPolicy, assetResolver } = {}) {
  const policy = policyFor(provider, requestPolicy ?? input?.requestPolicy);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const apiKey = apiKeyFor(provider, policy, env);
  const sourcePayload = input?.apiPayload ?? input;
  if (!sourcePayload || typeof sourcePayload !== 'object') throw new TypeError('Video input payload is required');
  const payload = await resolveAssets(sourcePayload, assetResolver, { provider, input });
  const body = await requestJson(fetchImpl, policy.endpoint, {
    method: policy.method ?? 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  return {
    provider,
    providerTaskId: taskIdFrom(provider, body),
    status: statusFrom(provider, body),
    metadata: sanitize(body),
  };
}

function queryUrl(provider, policy, taskId) {
  if (policy.queryEndpoint.includes('{taskId}')) return policy.queryEndpoint.replace('{taskId}', encodeURIComponent(taskId));
  if (provider === 'minimax-h3') {
    const separator = policy.queryEndpoint.includes('?') ? '&' : '?';
    return `${policy.queryEndpoint}${separator}task_id=${encodeURIComponent(taskId)}`;
  }
  return `${policy.queryEndpoint.replace(/\/$/, '')}/${encodeURIComponent(taskId)}`;
}

function waitMs(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, ms);
    if (!signal) return;
    const abort = () => {
      clearTimeout(timer);
      const error = new Error('Video poll cancelled');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export async function pollVideoJob({ provider, providerTaskId, fetchImpl = globalThis.fetch, env = process.env, requestPolicy, intervalMs = 2000, maxAttempts = 900, onStatus = () => {}, signal } = {}) {
  const policy = policyFor(provider, requestPolicy);
  if (!providerTaskId) throw new TypeError('providerTaskId is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const apiKey = apiKeyFor(provider, policy, env);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted) { const error = new Error('Video poll cancelled'); error.name = 'AbortError'; throw error; }
    const body = await requestJson(fetchImpl, queryUrl(provider, policy, String(providerTaskId)), {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
    });
    const status = statusFrom(provider, body);
    const event = { provider, providerTaskId: String(providerTaskId), status, attempt: attempt + 1, metadata: sanitize(body) };
    onStatus(event);
    if (status === 'succeeded') {
      const fileId = body?.file_id ?? body?.data?.file_id ?? null;
      let videoUrl = videoUrlFrom(body);
      let fileMetadata = null;
      if (!videoUrl && provider === 'minimax-h3' && fileId) {
        const retrieved = await retrieveMiniMaxFile({ fileId, policy, fetchImpl, apiKey });
        videoUrl = retrieved.url;
        fileMetadata = retrieved.metadata;
      }
      return { status, videoUrl, fileId, metadata: sanitize({ status: body, file: fileMetadata }) };
    }
    if (status === 'failed' || status === 'cancelled') {
      const error = new Error(`Provider failed: ${errorFrom(body)}`);
      error.provider = provider;
      error.providerTaskId = String(providerTaskId);
      error.status = status;
      error.metadata = sanitize(body);
      throw error;
    }
    await waitMs(intervalMs, signal);
  }
  throw new Error(`Provider poll timed out after ${maxAttempts} attempts`);
}

export async function downloadVideo(url, destination, fetchImpl = globalThis.fetch) {
  if (!/^https?:\/\//i.test(String(url ?? ''))) throw new Error('Video download requires an HTTP URL');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Video download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, destination);
  return { path: destination, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

export function sanitizeProviderMetadata(value) {
  return sanitize(value);
}
