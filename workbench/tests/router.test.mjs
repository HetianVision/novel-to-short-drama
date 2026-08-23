import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultStage, parseHash, workflowHash } from '../public/router.mjs';

test('parses home and workflow hashes', () => {
  assert.deepEqual(parseHash('#/'), { view: 'home' });
  assert.deepEqual(parseHash('#/projects/demo/workflow'), { view: 'workflow', projectId: 'demo', stage: null });
  assert.deepEqual(parseHash('#/projects/demo/workflow/script'), { view: 'workflow', projectId: 'demo', stage: 'script' });
});

test('rejects malformed routes and chooses the first incomplete stage', () => {
  assert.deepEqual(parseHash('#/projects/demo/other'), { view: 'home' });
  assert.deepEqual(parseHash('#/projects/demo/workflow/unknown'), { view: 'home' });
  assert.equal(defaultStage({ outline: { status: 'succeeded' }, characters: { status: 'running' } }), 'characters');
  assert.equal(workflowHash('demo', 'storyboard'), '#/projects/demo/workflow/storyboard');
});
