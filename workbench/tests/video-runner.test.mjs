import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadVideo, pollVideoJob, submitVideoJob } from '../lib/providers/video-runner.mjs';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
    async arrayBuffer() { return Buffer.from(JSON.stringify(body)); },
  };
}

test('MiniMax submit uses the current v1 endpoint and does not expose the API key', async () => {
  const calls = [];
  const result = await submitVideoJob({
    provider: 'minimax-h3',
    input: { apiPayload: { model: 'MiniMax-Hailuo-2.3', prompt: 'safe', first_frame_image: 'https://cdn.example/f1.png', duration: 6 } },
    env: { MINIMAX_API_KEY: 'secret-minimax-key' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ task_id: 'mm-1', status: 'Queueing' });
    },
  });
  assert.equal(result.providerTaskId, 'mm-1');
  assert.match(calls[0].url, /api\.minimaxi\.com\/v1\/video_generation$/);
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-minimax-key');
  assert.doesNotMatch(JSON.stringify(result), /secret-minimax-key/);
});

test('MiniMax mock poll returns the successful video URL', async () => {
  let calls = 0;
  const statuses = [];
  const result = await pollVideoJob({
    provider: 'minimax-h3',
    providerTaskId: 'mm-1',
    env: { MINIMAX_API_KEY: 'secret' },
    intervalMs: 0,
    fetchImpl: async (url) => {
      calls += 1;
      assert.match(url, /query\/video_generation\?task_id=mm-1$/);
      return calls === 1
        ? jsonResponse({ task_id: 'mm-1', status: 'Processing' })
        : jsonResponse({ task_id: 'mm-1', status: 'Success', video_url: 'https://cdn.example/mm-1.mp4' });
    },
    onStatus: (event) => statuses.push(event.status),
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.videoUrl, 'https://cdn.example/mm-1.mp4');
  assert.deepEqual(statuses, ['running', 'succeeded']);
});

test('MiniMax file_id is resolved through the official file retrieve endpoint', async () => {
  const urls = [];
  const result = await pollVideoJob({
    provider: 'minimax-h3',
    providerTaskId: 'mm-file-1',
    env: { MINIMAX_API_KEY: 'secret' },
    intervalMs: 0,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('/query/')) return jsonResponse({ task_id: 'mm-file-1', status: 'Success', file_id: 'file-1' });
      return jsonResponse({ file: { file_id: 'file-1', download_url: 'https://cdn.example/file-1.mp4' } });
    },
  });
  assert.equal(result.videoUrl, 'https://cdn.example/file-1.mp4');
  assert.ok(urls.some((url) => url.includes('/v1/files/retrieve?file_id=file-1')));
});

test('Seedance failed status preserves a sanitized provider error', async () => {
  await assert.rejects(
    pollVideoJob({
      provider: 'seedance',
      providerTaskId: 'sd-1',
      env: { ARK_API_KEY: 'secret' },
      intervalMs: 0,
      fetchImpl: async (url) => {
        assert.match(url, /generations\/tasks\/sd-1$/);
        return jsonResponse({ id: 'sd-1', status: 'failed', error: { message: 'provider failed: invalid prompt', api_key: 'secret' } });
      },
    }),
    (error) => /provider failed/i.test(error.message) && !/secret/.test(error.message),
  );
});

test('downloadVideo writes bytes and returns a sha256 checksum', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-download-'));
  const destination = join(root, 'video', 'E01-01.mp4');
  const bytes = Buffer.from('fake-mp4');
  const result = await downloadVideo('https://cdn.example/video.mp4', destination, async () => ({
    ok: true,
    status: 200,
    async arrayBuffer() { return bytes; },
  }));
  assert.equal(result.path, destination);
  assert.equal(result.size, bytes.length);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await stat(destination)).isFile(), true);
  assert.equal(await readFile(destination, 'utf8'), 'fake-mp4');
});

test('asset resolver converts local asset placeholders before submit', async () => {
  let submitted;
  await submitVideoJob({
    provider: 'seedance',
    input: { apiPayload: { model: 'doubao-seedance-1-0-pro-250528', content: [{ type: 'image_url', image_url: { url: 'asset://storyboard/E01-01/f1.png' } }] } },
    env: { ARK_API_KEY: 'secret' },
    assetResolver: async (value) => `https://assets.example/${value.slice('asset://'.length)}`,
    fetchImpl: async (_url, options) => {
      submitted = JSON.parse(options.body);
      return jsonResponse({ id: 'sd-1', status: 'queued' });
    },
  });
  assert.equal(submitted.content[0].image_url.url, 'https://assets.example/storyboard/E01-01/f1.png');
});
