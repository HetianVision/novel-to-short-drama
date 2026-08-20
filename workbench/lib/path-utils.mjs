import { isAbsolute, relative, resolve, sep } from 'node:path';

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertSafeId(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error(`Unsafe id: ${String(value)}`);
  }
  return value;
}

export function assertSafeFileName(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value === '.'
    || value === '..'
    || value.includes('\0')
    || isAbsolute(value)
    || /[\\/]/.test(value)
  ) {
    throw new Error(`Unsafe path filename: ${String(value)}`);
  }
  return value;
}

export function resolveInside(root, ...parts) {
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, ...parts);
  const rel = relative(rootPath, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes root: ${candidate}`);
  }
  return candidate;
}

export function relativeInside(root, target) {
  const candidate = resolveInside(root, target);
  return relative(resolve(root), candidate).split(sep).join('/');
}
