import test from 'node:test';
import assert from 'node:assert/strict';
import { readiness, STAGE_DEFINITIONS } from '../lib/task-definitions.mjs';

const baseProject = {
  id: 'demo-project',
  sources: [{ relativePath: 'source/novel.txt' }],
  stageState: {},
};

test('stage definitions preserve the original workflow skills', () => {
  assert.equal(STAGE_DEFINITIONS.outline.skillName, 'novel-outline');
  assert.equal(STAGE_DEFINITIONS.characters.skillName, 'novel-characters');
  assert.equal(STAGE_DEFINITIONS.art.skillName, 'novel-art');
  assert.equal(STAGE_DEFINITIONS.script.skillName, 'novel-script');
  assert.equal(STAGE_DEFINITIONS.storyboard.skillName, 'novel-storyboard');
});

test('storyboard is blocked without script', () => {
  const result = readiness(baseProject, 'storyboard');
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['script.json']);
});

test('script needs outline while art and cast remain optional warnings', () => {
  const project = {
    ...baseProject,
    stageState: { outline: { status: 'succeeded' } },
  };
  const result = readiness(project, 'script');
  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /art|角色/i);
});

test('unknown task types are rejected', () => {
  assert.throws(() => readiness(baseProject, 'unknown'), /task type/i);
});
