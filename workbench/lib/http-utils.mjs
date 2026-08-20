import { readFile } from 'node:fs/promises';

export const MAX_BODY_BYTES = 100 * 1024 * 1024;

export async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const body = await readBody(request, maxBytes);
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON body must be an object');
    return value;
  } catch (error) {
    const wrapped = new Error(`Invalid JSON body: ${error.message}`);
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

export function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

export function sendError(response, statusCode, message, extra = {}) {
  sendJson(response, statusCode, { error: message, ...extra });
}

export function sendText(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

export async function sendFile(response, path, contentType) {
  const body = await readFile(path);
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  response.end(body);
}

export function contentTypeFor(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown; charset=utf-8';
  if (lower.endsWith('.html')) return 'text/html; charset=utf-8';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  return 'application/octet-stream';
}
