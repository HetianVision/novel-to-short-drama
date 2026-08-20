import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SUCCESSFUL = new Set(['succeeded', 'partial']);

function stateHasOutput(project, stage) {
  const state = project?.stageState?.[stage];
  if (state && SUCCESSFUL.has(state.status)) return true;
  if (!project?.root) return false;
  const directory = join(project.root, stage);
  if (!existsSync(directory)) return false;
  return readdirSync(directory).some((name) => (
    name.endsWith('.json') && !/^(manifest|\.gates)/i.test(name)
  ));
}

function hasSource(project) {
  if ((project?.sources ?? []).length > 0) return true;
  if (!project?.root) return false;
  const source = join(project.root, 'source');
  return existsSync(source) && readdirSync(source).length > 0;
}

export const STAGE_DEFINITIONS = Object.freeze({
  outline: {
    label: '生成大纲',
    skillName: 'novel-outline',
    outputDirs: ['outline'],
    artifactNames: ['outline.json'],
    jsonToken: 'outline',
    reportName: 'outline-report.html',
    requiredCommands: ['validate', 'render'],
    upstreamStages: [],
  },
  characters: {
    label: '生成角色',
    skillName: 'novel-characters',
    outputDirs: ['characters'],
    artifactNames: ['cast.json'],
    jsonToken: 'cast',
    reportName: 'report.html',
    requiredCommands: ['seed', 'validate', 'render'],
    upstreamStages: ['outline'],
  },
  art: {
    label: '生成美术',
    skillName: 'novel-art',
    outputDirs: ['art'],
    artifactNames: ['art.json'],
    jsonToken: 'art',
    reportName: 'art-report.html',
    requiredCommands: ['seed', 'validate', 'render'],
    upstreamStages: ['outline', 'characters'],
  },
  script: {
    label: '生成剧本',
    skillName: 'novel-script',
    outputDirs: ['script'],
    artifactNames: ['script.json'],
    jsonToken: 'script',
    reportName: 'script-report.html',
    requiredCommands: ['seed', 'validate', 'render'],
    upstreamStages: ['outline', 'characters', 'art'],
  },
  storyboard: {
    label: '生成分镜',
    skillName: 'novel-storyboard',
    outputDirs: ['storyboard'],
    artifactNames: ['storyboard.json', 'manifest.json'],
    jsonToken: 'storyboard',
    reportName: 'storyboard-report.html',
    requiredCommands: ['seed', 'validate', 'render', 'export'],
    upstreamStages: ['script', 'outline', 'characters', 'art'],
  },
  image: {
    label: '生成图片',
    skillName: null,
    outputDirs: [],
    artifactNames: [],
  },
});

export function readiness(project = {}, taskType) {
  const definition = STAGE_DEFINITIONS[taskType];
  if (!definition) throw new Error(`Unknown task type: ${taskType}`);

  if (taskType === 'outline') {
    return hasSource(project)
      ? { ok: true, missing: [], warnings: [] }
      : { ok: false, missing: ['source material'], warnings: [] };
  }

  if (taskType === 'characters') {
    if (!hasSource(project)) return { ok: false, missing: ['source material'], warnings: [] };
    return {
      ok: true,
      missing: [],
      warnings: stateHasOutput(project, 'outline') ? [] : ['outline.json is optional for novel-characters; source-only mode will be used'],
    };
  }

  if (taskType === 'art') {
    if (!hasSource(project) && !stateHasOutput(project, 'outline')) {
      return { ok: false, missing: ['source material or outline.json'], warnings: [] };
    }
    return {
      ok: true,
      missing: [],
      warnings: [
        !stateHasOutput(project, 'outline') && 'outline.json is optional for novel-art',
        !stateHasOutput(project, 'characters') && 'cast.json is optional for novel-art',
      ].filter(Boolean),
    };
  }

  if (taskType === 'script') {
    if (!stateHasOutput(project, 'outline')) return { ok: false, missing: ['outline.json'], warnings: [] };
    return {
      ok: true,
      missing: [],
      warnings: [
        !stateHasOutput(project, 'characters') && 'cast.json is optional for novel-script',
        !stateHasOutput(project, 'art') && 'art.json is optional for novel-script',
      ].filter(Boolean),
    };
  }

  if (taskType === 'storyboard') {
    if (!stateHasOutput(project, 'script')) return { ok: false, missing: ['script.json'], warnings: [] };
    return {
      ok: true,
      missing: [],
      warnings: [
        !stateHasOutput(project, 'outline') && 'outline.json is optional for novel-storyboard',
        !stateHasOutput(project, 'characters') && 'cast.json is optional for novel-storyboard',
        !stateHasOutput(project, 'art') && 'art.json is optional for novel-storyboard',
      ].filter(Boolean),
    };
  }

  return { ok: false, missing: ['ownerStage'], warnings: [] };
}
