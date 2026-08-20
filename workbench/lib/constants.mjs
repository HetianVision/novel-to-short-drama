import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKBENCH_LIB_ROOT = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(WORKBENCH_LIB_ROOT, '../..');
export const PROJECTS_ROOT = resolve(REPO_ROOT, 'projects');
export const WORKBENCH_ROOT = resolve(REPO_ROOT, 'workbench');
export const PROVIDERS_ROOT = resolve(REPO_ROOT, 'providers');
export const SKILLS_ROOT = resolve(REPO_ROOT, 'skills');
