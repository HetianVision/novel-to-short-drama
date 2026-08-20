import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildSkillLock, readSkillVersions, verifySkillLock, writeSkillLock } from './skill-lock.mjs';

const execFileAsync = promisify(execFile);
const CONFIRMATION_PREFIX = 'skill-sync:';

function output(result) {
  return String(result?.stdout ?? result ?? '').trim();
}

function parseDiff(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => line.split('\t').slice(1))
    .filter((path) => path.startsWith('skills/'))
    .map((path) => path.slice('skills/'.length));
}

function tokenFor({ oldCommit, newCommit, changedFiles }) {
  return `${CONFIRMATION_PREFIX}${oldCommit ?? 'none'}:${newCommit}:${changedFiles.join(',')}`;
}

async function readLock(lockPath) {
  return JSON.parse(await readFile(lockPath, 'utf8'));
}

function commandError(error, args) {
  const detail = [error?.stderr, error?.stdout].filter(Boolean).join('\n').trim();
  return new Error(`Command failed: ${args.join(' ')}${detail ? `\n${detail.slice(0, 4000)}` : `\n${error?.message ?? error}`}`);
}

export function createSkillSync({
  repoRoot,
  skillsRoot = join(repoRoot, 'skills'),
  lockPath = join(repoRoot, 'skills.lock.json'),
  upstreamRemote = 'upstream',
  upstreamBranch = 'main',
  originRemote = 'origin',
  gitBin = 'git',
  nodeBin = process.execPath,
  runGitImpl = null,
  runNodeImpl = null,
  verifySkillLockImpl = verifySkillLock,
  buildSkillLockImpl = buildSkillLock,
  writeSkillLockImpl = writeSkillLock,
  readLockImpl = readLock,
} = {}) {
  if (!repoRoot) throw new TypeError('repoRoot is required');

  const runGit = runGitImpl ?? (async (args) => {
    try {
      return await execFileAsync(gitBin, args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      throw commandError(error, [gitBin, ...args]);
    }
  });
  const runNode = runNodeImpl ?? (async (args) => {
    try {
      return await execFileAsync(nodeBin, args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      throw commandError(error, [nodeBin, ...args]);
    }
  });

  async function check() {
    const lock = await readLockImpl(lockPath);
    const localLock = await verifySkillLockImpl(lockPath, skillsRoot);
    await runGit(['fetch', '--quiet', upstreamRemote, upstreamBranch]);
    const sourceCommit = output(await runGit(['rev-parse', `${upstreamRemote}/${upstreamBranch}`]));
    const oldCommit = String(lock.sourceCommit ?? '');
    let changedFiles = [];
    if (oldCommit && oldCommit !== sourceCommit) {
      changedFiles = parseDiff(output(await runGit(['diff', '--name-status', `${oldCommit}..${sourceCommit}`, '--', 'skills'])));
    }
    const uniqueFiles = [...new Set(changedFiles)].sort();
    return {
      ok: localLock.ok,
      localLockOk: localLock.ok,
      localMismatches: localLock.mismatches,
      source: lock.source,
      sourceBranch: upstreamBranch,
      currentCommit: oldCommit,
      sourceCommit,
      changedFiles: uniqueFiles,
      changed: uniqueFiles.length > 0,
      confirmationToken: uniqueFiles.length ? tokenFor({ oldCommit, newCommit: sourceCommit, changedFiles: uniqueFiles }) : null,
    };
  }

  async function sync({ confirm, pushOrigin = false } = {}) {
    const before = await check();
    if (!before.localLockOk) throw new Error(`Current Skill lock is not clean: ${before.localMismatches.join('; ')}`);
    if (!before.changed) return { status: 'up-to-date', ...before, pushed: false };
    if (confirm !== before.confirmationToken) throw new Error('Skill sync requires the confirmation token returned by check-update');

    const oldLock = await readLockImpl(lockPath);
    const originalBranch = output(await runGit(['rev-parse', '--abbrev-ref', 'HEAD']));
    const branchName = `sync/skills-${before.sourceCommit.slice(0, 12)}`;
    let branchCreated = false;
    let sourceCheckedOut = false;
    let commitCreated = false;
    try {
      const dirtySkills = output(await runGit(['status', '--porcelain', '--', 'skills']));
      if (dirtySkills) throw new Error('skills/ has local changes; refusing to overwrite an unlocked working tree');
      await runGit(['switch', '-c', branchName]);
      branchCreated = true;
      await runGit(['checkout', before.sourceCommit, '--', 'skills']);
      sourceCheckedOut = true;
      const skillNames = Object.keys(await readSkillVersions(skillsRoot)).sort();
      const selftests = [];
      for (const skillName of skillNames) {
        const script = join(skillsRoot, skillName, 'scripts', 'selftest.mjs');
        await runNode([script]);
        selftests.push({ skillName, status: 'passed' });
      }
      const nextLock = await buildSkillLockImpl({
        skillsRoot,
        sourceCommit: before.sourceCommit,
        sourceUrl: oldLock.source,
        sourceBranch: upstreamBranch,
      });
      await writeSkillLockImpl(lockPath, nextLock);
      await runGit(['add', '--', 'skills', 'skills.lock.json']);
      await runGit(['commit', '-m', `chore(skills): sync from upstream ${before.sourceCommit.slice(0, 12)}`]);
      commitCreated = true;
      const commit = output(await runGit(['rev-parse', 'HEAD']));
      let pushed = false;
      if (pushOrigin) {
        await runGit(['push', '--set-upstream', originRemote, branchName]);
        pushed = true;
      }
      return { status: 'synced', branch: branchName, commit, sourceCommit: before.sourceCommit, changedFiles: before.changedFiles, selftests, pushed };
    } catch (error) {
      if (!commitCreated) {
        try {
          if (sourceCheckedOut) await runGit(['checkout', oldLock.sourceCommit, '--', 'skills']);
          await writeSkillLockImpl(lockPath, oldLock);
          if (branchCreated) {
            await runGit(['switch', originalBranch]);
            await runGit(['branch', '-D', branchName]);
          }
        } catch (rollbackError) {
          error.rollbackError = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        }
      }
      throw error;
    }
  }

  return { check, sync };
}

export { parseDiff, tokenFor };
