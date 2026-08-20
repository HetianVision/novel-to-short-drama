import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir, readJson } from './helpers.mjs';
import {
  buildSkillLock,
  snapshotSkill,
  verifySkillLock,
  writeSkillLock,
} from '../lib/skill-lock.mjs';

async function makeFixtureSkills() {
  const root = await makeTempDir('skill-lock-skills-');
  await mkdir(join(root, 'novel-outline', 'scripts'), { recursive: true });
  await mkdir(join(root, 'shot-recipes', 'references'), { recursive: true });
  await writeFile(join(root, 'novel-outline', 'SKILL.md'), 'name: novel-outline\nversion: 1.2.0\n');
  await writeFile(join(root, 'novel-outline', 'scripts', 'run.mjs'), 'export const ok = true;\n');
  await writeFile(join(root, 'shot-recipes', 'SKILL.md'), 'name: shot-recipes\nversion: 1.0.0\n');
  await writeFile(join(root, 'shot-recipes', 'references', 'card.md'), '# card\n');
  return root;
}

test('lock contains every direct Skill and a hash', async () => {
  const fixtureSkills = await makeFixtureSkills();
  const lock = await buildSkillLock({ skillsRoot: fixtureSkills, sourceCommit: 'fixture-sha', sourceUrl: 'fixture' });
  assert.equal(lock.sourceCommit, 'fixture-sha');
  assert.equal(typeof lock.skills['novel-outline'].sha256, 'string');
  assert.equal(lock.skills['novel-outline'].version, '1.2.0');
  assert.deepEqual(Object.keys(lock.skills), ['novel-outline', 'shot-recipes']);
});

test('verification catches a changed Skill file', async () => {
  const fixtureSkills = await makeFixtureSkills();
  const lockPath = join(await makeTempDir('skill-lock-file-'), 'skills.lock.json');
  const lock = await buildSkillLock({ skillsRoot: fixtureSkills, sourceCommit: 'fixture-sha', sourceUrl: 'fixture' });
  await writeSkillLock(lockPath, lock);
  await writeFile(join(fixtureSkills, 'novel-outline', 'SKILL.md'), 'name: novel-outline\nversion: 9.9.9\n');
  const result = await verifySkillLock(lockPath, fixtureSkills);
  assert.equal(result.ok, false);
  assert.match(result.mismatches.join('\n'), /novel-outline/);
});

test('snapshot files and directories are read-only', async () => {
  const fixtureSkills = await makeFixtureSkills();
  const tempDir = await makeTempDir('skill-lock-snapshot-');
  const snapshot = await snapshotSkill({ skillsRoot: fixtureSkills, skillName: 'novel-outline', destination: tempDir });
  const fileMode = (await stat(join(snapshot.root, 'SKILL.md'))).mode & 0o222;
  const dirMode = (await stat(snapshot.root)).mode & 0o222;
  assert.equal(fileMode, 0);
  assert.equal(dirMode, 0);
  assert.equal(snapshot.files.includes('SKILL.md'), true);
  await assert.rejects(writeFile(join(snapshot.root, 'SKILL.md'), 'changed\n'), /read-only|permission|EACCES|EPERM/i);
});

test('snapshot rejects source symlinks instead of copying outside the Skill', async () => {
  const fixtureSkills = await makeFixtureSkills();
  await symlink('/tmp', join(fixtureSkills, 'novel-outline', 'outside-link'), 'dir');
  const tempDir = await makeTempDir('skill-lock-snapshot-');
  await assert.rejects(
    snapshotSkill({ skillsRoot: fixtureSkills, skillName: 'novel-outline', destination: tempDir }),
    /symlink/i,
  );
});
