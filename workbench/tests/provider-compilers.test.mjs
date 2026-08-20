import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadProviderConfig } from '../lib/providers/provider-config.mjs';
import { compileMiniMaxH3 } from '../lib/providers/minimax-h3.mjs';
import { compileSeedance, validateProviderInput } from '../lib/providers/seedance.mjs';

const repoRoot = join(import.meta.dirname, '../..');

const job = {
  schemaVersion: '1.0',
  projectId: 'demo-project',
  episodeId: 'E01',
  segmentId: 'E01-01',
  durationSeconds: 8,
  ratio: '16:9',
  style: 'live-action, cold gray-green palette',
  cuts: [
    { index: 1, startSeconds: 0, endSeconds: 4, durationSeconds: 4, size: 'medium', camera: 'Push In', frame: 'medium shot of a woman holding a suitcase', characters: ['C01'], props: ['P01'], dialogue: [{ speaker: 'C01', line: '别碰它。', delivery: '低声' }] },
    { index: 2, startSeconds: 4, endSeconds: 8, durationSeconds: 4, size: 'wide', camera: 'Static Shot', frame: 'wide shot of a foggy ferry', characters: [], props: [], dialogue: [] },
  ],
  dialogue: [{ speaker: 'C01', line: '别碰它。', delivery: '低声' }],
  sound: { soundscape: 'water and wood creaks', music: 'low strings' },
  h3Prompt: 'How the reference pictures align with the target video — Picture 1 ... integrated_multimodal_description: [Shot 1] <d>[Chinese] 别碰它。</d>',
  firstFramePath: 'storyboard/E01-01/f1.png',
  lastFramePath: 'storyboard/E01-01/f2.png',
  references: [
    { kind: 'frame', assetId: 'frame-1', path: 'storyboard/E01-01/f1.png', role: 'first_frame', exists: true },
    { kind: 'frame', assetId: 'frame-2', path: 'storyboard/E01-01/f2.png', role: 'last_frame', exists: true },
    { kind: 'character', assetId: 'C01', name: '沈知微', path: 'characters/images/沈知微-sheet.png', exists: true },
    { kind: 'scene', assetId: 'S01', name: '渡船船舱', path: 'art/images/渡船船舱-sheet.png', exists: true },
    { kind: 'prop', assetId: 'P01', name: '旧皮箱', path: 'art/images/旧皮箱-sheet.png', exists: true },
  ],
};

test('MiniMax compiler uses its own prompt and first-frame role', async () => {
  const config = await loadProviderConfig('minimax-h3', { providersRoot: join(repoRoot, 'providers') });
  const input = compileMiniMaxH3(job, config);
  const text = input.content.find((item) => item.type === 'text').text;
  const firstFrame = input.content.find((item) => item.type === 'image_url');

  assert.equal(input.provider, 'minimax-h3');
  assert.equal(firstFrame.role, 'first_frame');
  assert.match(text, /Picture 1/);
  assert.doesNotMatch(text, /integrated_multimodal_description|<d>/i);
  assert.equal(input.apiPayload.first_frame_image, 'asset://storyboard/E01-01/f1.png');
  assert.equal(input.apiPayload.prompt_optimizer, false);
  assert.ok(text.length <= 2000);
});

test('Seedance compiler does not send H3 prompt unchanged', async () => {
  const config = await loadProviderConfig('seedance', { providersRoot: join(repoRoot, 'providers') });
  const input = compileSeedance(job, config);
  const text = input.content.find((item) => item.type === 'text').text;
  const images = input.content.filter((item) => item.type === 'image_url');

  assert.equal(input.provider, 'seedance');
  assert.notEqual(text, job.h3Prompt);
  assert.match(text, /camera|镜头/i);
  assert.ok(images.length >= 3);
  assert.ok(images.every((item) => item.role === 'reference_image'));
  assert.equal(input.apiPayload.duration, 8);
  assert.equal(input.apiPayload.ratio, '16:9');
  assert.doesNotMatch(text, /integrated_multimodal_description|<d>/i);
});

test('Seedance rejects reference_image mixed with first-frame mode', async () => {
  const config = await loadProviderConfig('seedance', { providersRoot: join(repoRoot, 'providers') });
  const input = compileSeedance(job, config);
  input.imageMode = 'first_last_frame';
  input.content.push({ type: 'image_url', image_url: { url: 'asset://storyboard/E01-01/f2.png' }, role: 'reference_image' });
  assert.throws(() => validateProviderInput('seedance', input), /mutually exclusive/i);
});

test('provider compiler enforces Seedance duration limit before submission', async () => {
  const config = await loadProviderConfig('seedance', { providersRoot: join(repoRoot, 'providers') });
  assert.throws(() => compileSeedance({ ...job, durationSeconds: 13 }, config), /duration.*12|12.*duration/i);
});
