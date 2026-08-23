export const STAGE_KEYS = Object.freeze([
  'outline',
  'characters',
  'art',
  'script',
  'storyboard',
  'image',
  'video',
]);

const TERMINAL_STATUSES = new Set(['succeeded', 'partial']);

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseHash(hash = '') {
  const value = String(hash || '#/');
  if (value === '#' || value === '#/') return { view: 'home' };

  const match = value.match(/^#\/projects\/([^/]+)\/workflow(?:\/([^/]+))?\/?$/);
  if (!match) return { view: 'home' };

  const projectId = decodeSegment(match[1]);
  const stage = match[2] ? decodeSegment(match[2]) : null;
  if (!projectId || (stage && !STAGE_KEYS.includes(stage))) return { view: 'home' };
  return { view: 'workflow', projectId, stage };
}

export function workflowHash(projectId, stage = null) {
  const base = `#/projects/${encodeURIComponent(projectId)}/workflow`;
  return stage && STAGE_KEYS.includes(stage) ? `${base}/${encodeURIComponent(stage)}` : base;
}

export function defaultStage(stageState = {}) {
  return STAGE_KEYS.find((stage) => !TERMINAL_STATUSES.has(stageState?.[stage]?.status)) ?? STAGE_KEYS.at(-1);
}
