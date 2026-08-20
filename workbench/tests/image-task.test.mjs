import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImageTask, classifyImageResult } from '../lib/image-runner.mjs';

test('image task rejects an unknown owner stage', () => {
  assert.throws(
    () => buildImageTask({ projectId: 'demo-project', ownerStage: 'script', assetIds: ['S01'] }),
    /owner stage/i,
  );
});

test('missing image is partial, not successful', async () => {
  const result = await classifyImageResult({
    requested: ['S01', 'S02'],
    present: ['S01'],
    promptFiles: ['S01.prompt.md', 'S02.prompt.md'],
    processExitCode: 0,
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.missing, ['S02']);
});

test('all requested images require files before the task can succeed', () => {
  const result = classifyImageResult({
    requested: ['S01'],
    present: [],
    promptFiles: [],
    processExitCode: 0,
  });
  assert.equal(result.status, 'failed');
});
