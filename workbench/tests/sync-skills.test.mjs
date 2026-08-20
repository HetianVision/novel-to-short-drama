import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createSkillSync, parseDiff, tokenFor } from '../lib/sync-skills.mjs';

test('parseDiff returns only changed files under skills', () => {
  assert.deepEqual(parseDiff('M\tskills/novel-outline/SKILL.md\nA\tworkbench/server.mjs\nR100\tskills/a\tskills/b'), ['novel-outline/SKILL.md', 'a', 'b']);
});

test('check-update reads upstream state without editing the Skill tree', async () => {
  const calls = [];
  const sync = createSkillSync({
    repoRoot: '/repo',
    skillsRoot: '/repo/skills',
    lockPath: '/repo/skills.lock.json',
    readLockImpl: async () => ({ sourceCommit: 'old', source: 'fixture', skills: {} }),
    verifySkillLockImpl: async () => ({ ok: true, mismatches: [], lock: { sourceCommit: 'old' } }),
    runGitImpl: async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { stdout: 'newcommit\n' };
      if (args[0] === 'diff') return { stdout: 'M\tskills/novel-outline/SKILL.md\n' };
      return { stdout: '' };
    },
  });
  const result = await sync.check();
  assert.equal(result.changed, true);
  assert.deepEqual(result.changedFiles, ['novel-outline/SKILL.md']);
  assert.equal(result.confirmationToken, tokenFor({ oldCommit: 'old', newCommit: 'newcommit', changedFiles: ['novel-outline/SKILL.md'] }));
  assert.ok(calls.some((args) => args[0] === 'fetch'));
  assert.ok(calls.some((args) => args[0] === 'diff'));
});

test('sync refuses a missing or stale confirmation token before checkout', async () => {
  let checkoutCalled = false;
  const sync = createSkillSync({
    repoRoot: '/repo',
    skillsRoot: '/repo/skills',
    lockPath: '/repo/skills.lock.json',
    readLockImpl: async () => ({ sourceCommit: 'old', source: 'fixture', skills: {} }),
    verifySkillLockImpl: async () => ({ ok: true, mismatches: [], lock: { sourceCommit: 'old' } }),
    runGitImpl: async (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'newcommit\n' };
      if (args[0] === 'diff') return { stdout: 'M\tskills/novel-outline/SKILL.md\n' };
      if (args[0] === 'checkout') checkoutCalled = true;
      return { stdout: '' };
    },
  });
  await assert.rejects(sync.sync({ confirm: 'confirmed-by-user' }), /confirmation token/i);
  assert.equal(checkoutCalled, false);
});
