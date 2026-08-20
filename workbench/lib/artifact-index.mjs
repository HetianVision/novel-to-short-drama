import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const SKIP_WORKBENCH_DIRS = new Set(['events', 'tasks', 'runs']);

function typeFor(relativePath) {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.html') && (lower.includes('report') || lower.endsWith('/report.html'))) return 'report';
  if (/\.(png|jpe?g|webp|gif|avif)$/i.test(lower)) return 'image';
  if (/\.(mp4|mov|webm|m4v)$/i.test(lower)) return 'video';
  return 'other';
}

async function walk(root, current = root, output = []) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(current, entry.name);
    const relativePath = relative(root, absolute).split(sep).join('/');
    if (entry.isSymbolicLink()) throw new Error(`Artifact symlink is not allowed: ${relativePath}`);
    if (entry.isDirectory()) {
      if (relativePath === '.workbench') {
        const nested = await readdir(absolute, { withFileTypes: true });
        for (const child of nested) {
          if (!child.isFile() || !['report.html', 'artifacts.json'].includes(child.name)) continue;
          const childPath = join(absolute, child.name);
          const bytes = await readFile(childPath);
          const childRelativePath = relative(root, childPath).split(sep).join('/');
          output.push({
            id: childRelativePath,
            relativePath: childRelativePath,
            type: typeFor(childRelativePath),
            size: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          });
        }
        continue;
      }
      if (relativePath.startsWith('.workbench/') && SKIP_WORKBENCH_DIRS.has(entry.name)) {
        continue;
      }
      await walk(root, absolute, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await readFile(absolute);
    output.push({
      id: relativePath,
      relativePath,
      type: typeFor(relativePath),
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return output;
}

export async function indexArtifacts(projectRoot) {
  return (await walk(projectRoot)).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export class ArtifactContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArtifactContractError';
  }
}

const JSON_PATTERNS = {
  outline: /^outline\/.*(?:outline|\.json$)/i,
  characters: /^characters\/.*(?:cast|characters|\.json$)/i,
  art: /^art\/.*(?:art|\.json$)/i,
  script: /^script\/.*(?:script|\.json$)/i,
  storyboard: /^storyboard\/.*(?:storyboard|\.json$)/i,
};

export function assertExpectedArtifacts(taskType, artifacts) {
  if (taskType === 'image') {
    if (!artifacts.some((artifact) => artifact.type === 'image')) {
      throw new ArtifactContractError('Image task produced no image artifact');
    }
    return;
  }
  if (taskType === 'video') {
    if (!artifacts.some((artifact) => artifact.type === 'video')) {
      throw new ArtifactContractError('Video task produced no video artifact');
    }
    return;
  }
  const pattern = JSON_PATTERNS[taskType];
  if (!pattern) throw new ArtifactContractError(`No artifact contract for task type: ${taskType}`);
  if (!artifacts.some((artifact) => artifact.type === 'json' && pattern.test(artifact.relativePath) && !/manifest|gates/i.test(artifact.relativePath))) {
    throw new ArtifactContractError(`Missing required ${taskType} JSON artifact`);
  }
  if (!artifacts.some((artifact) => artifact.type === 'report')) {
    throw new ArtifactContractError(`Missing report artifact for ${taskType}`);
  }
}
