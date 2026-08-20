import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSkillPrompt } from '../lib/prompt-builder.mjs';

test('prompt forbids Skill writes and names only the stage output directory', () => {
  const prompt = buildSkillPrompt({
    task: { type: 'outline', skillName: 'novel-outline', outputDir: 'outline', options: { episodes: 6 } },
    project: { id: 'demo-project', root: '/tmp/projects/demo-project' },
    skillSnapshot: { root: '/tmp/projects/demo-project/.workbench/runs/task/skill/novel-outline' },
    inputPaths: ['/tmp/projects/demo-project/source/novel.txt'],
  });
  assert.match(prompt, /Do not modify.*skills/i);
  assert.match(prompt, /novel-outline[\\/]SKILL\.md/);
  assert.match(prompt, /projects\/demo-project\/outline/);
  assert.match(prompt, /episodes/);
});
