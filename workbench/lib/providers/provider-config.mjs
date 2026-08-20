import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const PROVIDER_IDS = Object.freeze(['minimax-h3', 'seedance']);

async function readConfig(root, name) {
  try {
    return JSON.parse(await readFile(join(root, name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Missing provider config: ${join(root, name)}`);
    if (error instanceof SyntaxError) throw new Error(`Invalid provider config ${join(root, name)}: ${error.message}`);
    throw error;
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

export async function loadProviderConfig(provider, { providersRoot } = {}) {
  if (!PROVIDER_IDS.includes(provider)) throw new Error(`Unknown provider: ${provider}`);
  if (!providersRoot) throw new TypeError('providersRoot is required');
  const root = resolve(providersRoot, provider);
  const [promptProfile, referencePolicy, requestPolicy] = await Promise.all([
    readConfig(root, 'prompt-profile.json'),
    readConfig(root, 'reference-policy.json'),
    readConfig(root, 'request-policy.json'),
  ]);
  assertObject(promptProfile, `${provider} prompt profile`);
  assertObject(referencePolicy, `${provider} reference policy`);
  assertObject(requestPolicy, `${provider} request policy`);
  for (const [name, value] of Object.entries({ promptProfile, referencePolicy, requestPolicy })) {
    if (value.provider !== provider) throw new Error(`${provider} ${name} has mismatched provider id`);
  }
  return { provider, root, promptProfile, referencePolicy, requestPolicy };
}

export function assetUrl(reference) {
  if (!reference) throw new Error('Cannot compile an empty reference');
  if (reference.url) return String(reference.url);
  if (!reference.path) throw new Error(`Reference ${reference.assetId ?? '?'} has no path or URL`);
  if (String(reference.path).startsWith('/')) throw new Error(`Absolute reference path is not allowed: ${reference.path}`);
  return `asset://${String(reference.path).replaceAll('\\', '/')}`;
}

export function ensureProviderText(input, provider) {
  if (!input || typeof input !== 'object') throw new TypeError(`${provider} input must be an object`);
  if (!Array.isArray(input.content)) throw new Error(`${provider} input content must be an array`);
  if (!input.content.some((item) => item?.type === 'text' && String(item.text ?? '').trim())) {
    throw new Error(`${provider} input must contain a text item`);
  }
}

export function validateProviderInput(provider, input) {
  ensureProviderText(input, provider);
  const images = input.content.filter((item) => item?.type === 'image_url');
  if (provider === 'minimax-h3') {
    if (images.length > 2) throw new Error('MiniMax input accepts at most first and last frame images');
    const roles = new Set(images.map((item) => item.role));
    if (roles.has('reference_image')) throw new Error('MiniMax does not accept reference_image content roles');
    if (images.length && !roles.has('first_frame')) throw new Error('MiniMax image input must include a first_frame role');
    return;
  }
  if (provider !== 'seedance') throw new Error(`Unknown provider: ${provider}`);
  const roles = new Set(images.map((item) => item.role));
  if (input.imageMode === 'first_last_frame' && roles.has('reference_image')) {
    throw new Error('Seedance reference_image and first-frame mode are mutually exclusive');
  }
  if (roles.has('reference_image') && (roles.has('first_frame') || roles.has('last_frame'))) {
    throw new Error('Seedance reference_image and first/last frame roles are mutually exclusive');
  }
  if (![...roles].every((role) => ['reference_image', 'first_frame', 'last_frame'].includes(role))) {
    throw new Error('Seedance image role is unsupported');
  }
}
