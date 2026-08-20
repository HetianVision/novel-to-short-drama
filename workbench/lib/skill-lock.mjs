import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { assertSafeId, resolveInside } from './path-utils.mjs';

function timestampValue(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.toISOString() : String(value);
}

async function directSkillNames(skillsRoot) {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

async function regularFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill symlink is not allowed: ${absolute}`);
    if (entry.isDirectory()) {
      files.push(...await regularFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push({
        absolute,
        relative: relative(root, absolute).split(sep).join('/'),
      });
    }
  }
  return files;
}

export async function hashSkillDirectory(skillRoot) {
  const files = await regularFiles(skillRoot);
  const hashes = {};
  const aggregate = createHash('sha256');
  for (const file of files) {
    const bytes = await readFile(file.absolute);
    const fileHash = createHash('sha256').update(bytes).digest('hex');
    hashes[file.relative] = fileHash;
    aggregate.update(file.relative);
    aggregate.update('\0');
    aggregate.update(bytes);
    aggregate.update('\0');
  }
  return { sha256: aggregate.digest('hex'), hashes };
}

export async function readSkillVersions(skillsRoot) {
  const result = {};
  for (const skillName of await directSkillNames(skillsRoot)) {
    const skillRoot = resolveInside(skillsRoot, skillName);
    const skillFile = join(skillRoot, 'SKILL.md');
    const text = await readFile(skillFile, 'utf8');
    const match = text.match(/^version:\s*([^\s#]+)\s*$/m);
    if (!match) throw new Error(`Skill ${skillName} has no version in SKILL.md`);
    result[skillName] = match[1];
  }
  return result;
}

export async function buildSkillLock({
  skillsRoot,
  sourceCommit,
  sourceUrl = 'https://github.com/eternityspring/shuohao-skills.git',
  sourceBranch = 'main',
  now = () => new Date().toISOString(),
}) {
  if (typeof sourceCommit !== 'string' || !sourceCommit) throw new Error('sourceCommit is required');
  const versions = await readSkillVersions(skillsRoot);
  const skills = {};
  for (const skillName of Object.keys(versions).sort()) {
    const hashes = await hashSkillDirectory(resolveInside(skillsRoot, skillName));
    skills[skillName] = {
      version: versions[skillName],
      sha256: hashes.sha256,
      files: hashes.hashes,
    };
  }
  return {
    source: sourceUrl,
    sourceBranch,
    sourceCommit,
    syncedAt: timestampValue(now),
    skills,
  };
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

export async function writeSkillLock(lockPath, lock) {
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(stableObject(lock), null, 2)}\n`, 'utf8');
}

export async function verifySkillLock(lockPath, skillsRoot) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const actualVersions = await readSkillVersions(skillsRoot);
  const mismatches = [];
  const expectedNames = Object.keys(lock.skills ?? {}).sort();
  const actualNames = Object.keys(actualVersions).sort();

  for (const name of expectedNames) {
    if (!(name in actualVersions)) mismatches.push(`missing Skill: ${name}`);
  }
  for (const name of actualNames) {
    if (!(name in (lock.skills ?? {}))) mismatches.push(`unlocked Skill: ${name}`);
  }

  for (const skillName of expectedNames) {
    if (!(skillName in actualVersions)) continue;
    const expected = lock.skills[skillName];
    const actual = await hashSkillDirectory(resolveInside(skillsRoot, skillName));
    if (expected.version !== actualVersions[skillName]) {
      mismatches.push(`${skillName} version mismatch: expected ${expected.version}, got ${actualVersions[skillName]}`);
    }
    if (expected.sha256 !== actual.sha256) mismatches.push(`${skillName} sha256 mismatch`);
    for (const file of new Set([...Object.keys(expected.files ?? {}), ...Object.keys(actual.hashes)]).values()) {
      if (expected.files?.[file] !== actual.hashes[file]) mismatches.push(`${skillName}/${file} hash mismatch`);
    }
  }

  return { ok: mismatches.length === 0, mismatches, lock };
}

async function copySkillTree(source, destination, root, files, hashes, directories) {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill symlink is not allowed: ${from}`);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      directories.push(to);
      await copySkillTree(from, to, root, files, hashes, directories);
    } else if (entry.isFile()) {
      const bytes = await readFile(from);
      await writeFile(to, bytes, { flag: 'w' });
      const relativePath = relative(root, to).split(sep).join('/');
      files.push(relativePath);
      hashes[relativePath] = createHash('sha256').update(bytes).digest('hex');
    }
  }
}

export async function snapshotSkill({ skillsRoot, skillName, destination }) {
  assertSafeId(skillName);
  const source = resolveInside(skillsRoot, skillName);
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`Invalid Skill root: ${skillName}`);

  const root = resolve(destination, skillName);
  await mkdir(root, { recursive: true });
  const files = [];
  const hashes = {};
  const directories = [root];
  await copySkillTree(source, root, root, files, hashes, directories);
  for (const file of files) await chmod(join(root, file), 0o444);
  for (const directory of directories.sort((a, b) => b.length - a.length)) await chmod(directory, 0o555);
  return { root, files: files.sort(), hashes };
}
