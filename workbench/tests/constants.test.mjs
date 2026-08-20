import test from 'node:test';
import assert from 'node:assert/strict';
import { REPO_ROOT, PROJECTS_ROOT, SKILLS_ROOT, WORKBENCH_ROOT } from '../lib/constants.mjs';

test('root paths stay inside the repository', () => {
  assert.equal(PROJECTS_ROOT, `${REPO_ROOT}/projects`);
  assert.equal(SKILLS_ROOT, `${REPO_ROOT}/skills`);
  assert.equal(WORKBENCH_ROOT, `${REPO_ROOT}/workbench`);
  assert.equal(REPO_ROOT.startsWith('/'), true);
});
