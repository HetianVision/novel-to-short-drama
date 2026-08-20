#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { REPO_ROOT, SKILLS_ROOT } from './lib/constants.mjs';
import { startServer } from './server.mjs';
import { buildSkillLock, verifySkillLock, writeSkillLock } from './lib/skill-lock.mjs';
import { runCodexImageSmoke, runProviderSmoke } from './tests/live-smoke.mjs';

const execFileAsync = promisify(execFile);

async function run(command, args, label) {
  try {
    const result = await execFileAsync(command, args, { cwd: REPO_ROOT, maxBuffer: 128 * 1024 * 1024 });
    console.log(`✓ ${label}`);
    return result;
  } catch (error) {
    const detail = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').slice(0, 8000);
    throw new Error(`${label} failed\n${detail}`);
  }
}

function skillNames() {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_ROOT, entry.name, 'scripts', 'selftest.mjs')))
    .map((entry) => entry.name)
    .sort();
}

async function runTests() {
  await run(process.execPath, ['scripts/report-selftest.mjs'], 'report selftest');
  for (const name of skillNames()) await run(process.execPath, [join('skills', name, 'scripts', 'selftest.mjs')], `${name} selftest`);
  await run(process.execPath, ['workbench/tests/run.mjs'], 'workbench tests and deterministic fixture benchmark');
  await run(process.execPath, ['--test', 'workbench/tests/e2e-fixture.test.mjs'], 'fixture benchmark repeatability');
  const lock = await verifySkillLock(join(REPO_ROOT, 'skills.lock.json'), SKILLS_ROOT);
  if (!lock.ok) throw new Error(`Skill lock verification failed: ${lock.mismatches.join('; ')}`);
  await run('git', ['diff', '--quiet', '--', 'skills'], 'Skill tree unchanged');
  await run('git', ['diff', '--cached', '--quiet', '--', 'skills'], 'staged Skill tree unchanged');
  console.log(`Benchmark complete: ${skillNames().length} Skill selftests + report selftest + workbench suite + fixture benchmark.`);
}

async function rebuildLock() {
  const lockPath = join(REPO_ROOT, 'skills.lock.json');
  const current = await verifySkillLock(lockPath, SKILLS_ROOT);
  if (!current.ok) throw new Error(`Refusing to rebuild a dirty Skill lock: ${current.mismatches.join('; ')}`);
  await run('git', ['fetch', '--quiet', 'upstream', 'main'], 'fetch upstream/main');
  const commit = (await run('git', ['rev-parse', 'upstream/main'], 'read upstream/main')).stdout.trim();
  if (commit !== current.lock.sourceCommit) {
    throw new Error(`skills/ is locked to ${current.lock.sourceCommit}, while upstream/main is ${commit}; run confirmed Skill sync first`);
  }
  await writeSkillLock(lockPath, await buildSkillLock({ skillsRoot: SKILLS_ROOT, sourceCommit: commit, sourceUrl: current.lock.source, sourceBranch: current.lock.sourceBranch }));
  console.log(`Skill lock rebuilt for ${commit}.`);
}

function help() {
  console.log(`Usage:
  node workbench/cli.mjs start [--port 4318]
  node workbench/cli.mjs test
  node workbench/cli.mjs skills-lock
  node workbench/cli.mjs live-smoke --codex
  node workbench/cli.mjs live-smoke --provider minimax-h3|seedance`);
}

async function main(argv) {
  const command = argv[0];
  if (command === 'start') {
    const index = argv.indexOf('--port');
    const port = index >= 0 ? Number(argv[index + 1]) : 4318;
    const server = await startServer({ port, host: '127.0.0.1' });
    const address = server.address();
    console.log(`Workbench listening at http://${address.address}:${address.port}`);
    return;
  }
  if (command === 'test') return runTests();
  if (command === 'skills-lock') return rebuildLock();
  if (command === 'live-smoke') {
    const providerIndex = argv.indexOf('--provider');
    const provider = providerIndex >= 0 ? argv[providerIndex + 1] : null;
    if (!argv.includes('--codex') && !provider) throw new Error('live-smoke requires --codex or --provider <name>');
    if (argv.includes('--codex')) console.log(JSON.stringify(await runCodexImageSmoke({ codexBin: process.env.CODEX_BIN ?? 'codex' })));
    if (provider) console.log(JSON.stringify(await runProviderSmoke({ provider })));
    return;
  }
  help();
}

main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
