import { basename, isAbsolute, join } from 'node:path';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function inputWithToken(inputPaths, token) {
  return inputPaths.find((path) => basename(path).toLowerCase().includes(token.toLowerCase())) ?? `<${token}.json>`;
}

function textInput(inputPaths) {
  return inputPaths.find((path) => /\.(txt|md|markdown)$/i.test(path)) ?? inputPaths[0] ?? '<book.txt>';
}

function stageProcedure(task, skillRoot, outputRoot, inputPaths) {
  const script = (name) => join(skillRoot, 'scripts', `${name}.mjs`);
  const source = textInput(inputPaths);
  const outline = inputWithToken(inputPaths, 'outline');
  const cast = inputWithToken(inputPaths, 'cast');
  const art = inputWithToken(inputPaths, 'art');
  const scriptJson = inputWithToken(inputPaths, 'script');
  const episodes = task.options?.episodes ?? '1-3';
  const json = (name) => join(outputRoot, name);
  const render = (jsonPath, reportName, flags = '') => [
    `node ${script(task.skillName)} render ${jsonPath} --md > ${join(outputRoot, reportName.replace(/\.html$/i, '.md'))}`,
    `node ${script(task.skillName)} render ${jsonPath} --html${flags} > ${join(outputRoot, reportName)}`,
  ];

  if (task.type === 'outline') {
    return [
      `Read the novel/material source at ${source}.`,
      `Write the model-authored result to ${json('outline.json')}.`,
      `node ${script('novel-outline')} validate ${json('outline.json')}`,
      ...render(json('outline.json'), 'outline-report.html'),
    ];
  }
  if (task.type === 'characters') {
    return [
      `Read the novel/material source at ${source}.`,
      `For a long source, use node ${script('novel-characters')} chunk ${source} <workdir> before the roster pass.`,
      outline === '<outline.json>' ? 'Skip the optional seed because no outline.json is available.' : `node ${script('novel-characters')} seed ${outline} > ${join(outputRoot, 'seed.json')}`,
      outline === '<outline.json>' ? 'No outline.json is available; use the source-only workflow.' : `Use ${outline} as the optional novel-characters seed input.`,
      `Write the model-authored result to ${json('cast.json')}.`,
      `node ${script('novel-characters')} validate ${json('cast.json')} ${source}`,
      ...render(json('cast.json'), 'report.html', ` --lang ${task.options?.lang ?? 'zh'}`),
    ];
  }
  if (task.type === 'art') {
    return [
      outline === '<outline.json>' ? `Read the novel/material source at ${source}.` : `Use ${outline} as the novel-art seed input.`,
      outline === '<outline.json>' ? 'There is no art seed; build the scene and prop skeleton from the source.' : `node ${script('novel-art')} seed ${outline} > ${join(outputRoot, 'seed.json')}`,
      cast === '<cast.json>' ? 'No cast.json is available; skip the optional cast cross-check.' : `Use ${cast} for the optional character-name cross-check.`,
      `Write the model-authored result to ${json('art.json')}.`,
      `node ${script('novel-art')} validate ${json('art.json')}${cast === '<cast.json>' ? '' : ` --cast ${cast}`}`,
      ...render(json('art.json'), 'art-report.html', ` --lang ${task.options?.lang ?? 'zh'}`),
    ];
  }
  if (task.type === 'script') {
    return [
      `Use ${outline} as the direct novel-script input.`,
      `node ${script('novel-script')} seed ${outline} --eps ${episodes} > ${join(outputRoot, 'seed.json')}`,
      art === '<art.json>' ? 'No art.json is available; make the optional art cross-check explicit.' : `Use ${art} for the optional scene and lighting cross-check.`,
      cast === '<cast.json>' ? 'No cast.json is available; use outline character ids and state the omission.' : `Use ${cast} for character voice and display names.`,
      `Write the model-authored result to ${json('script.json')}.`,
      `node ${script('novel-script')} validate ${json('script.json')} --outline ${outline}${art === '<art.json>' ? '' : ` --art ${art}`}`,
      ...render(json('script.json'), 'script-report.html', ` --outline ${outline}${art === '<art.json>' ? '' : ` --art ${art}`}${cast === '<cast.json>' ? '' : ` --cast ${cast}`}`),
    ];
  }
  if (task.type === 'storyboard') {
    return [
      `Use ${scriptJson} as the required novel-storyboard input.`,
      `node ${script('novel-storyboard')} seed ${scriptJson} --eps ${episodes} > ${join(outputRoot, 'seed.json')}`,
      outline === '<outline.json>' ? 'No outline.json is available; skip that optional display input.' : `Use ${outline} as an optional upstream input.`,
      cast === '<cast.json>' ? 'No cast.json is available; skip that optional character input.' : `Use ${cast} as an optional character input.`,
      art === '<art.json>' ? 'No art.json is available; skip that optional scene input.' : `Use ${art} as an optional scene and reference-asset input.`,
      `Write the model-authored result to ${json('storyboard.json')}.`,
      `node ${script('novel-storyboard')} validate ${json('storyboard.json')} --script ${scriptJson}${outline === '<outline.json>' ? '' : ` --outline ${outline}`}${cast === '<cast.json>' ? '' : ` --cast ${cast}`}${art === '<art.json>' ? '' : ` --art ${art}`}`,
      ...render(json('storyboard.json'), 'storyboard-report.html', ` --script ${scriptJson}${outline === '<outline.json>' ? '' : ` --outline ${outline}`}${art === '<art.json>' ? '' : ` --art ${art}`}`),
      `node ${script('novel-storyboard')} export ${json('storyboard.json')} --script ${scriptJson} --out ${outputRoot}`,
    ];
  }
  return [];
}

export function buildSkillPrompt({ task, project, skillSnapshot, inputPaths = [], outputRoot: explicitOutputRoot = null }) {
  const skillRoot = typeof skillSnapshot === 'string' ? skillSnapshot : skillSnapshot?.root;
  if (!skillRoot) throw new Error('Skill snapshot root is required');
  const outputDir = task.outputDir ?? task.outputDirs?.[0] ?? task.type;
  const outputRoot = explicitOutputRoot ?? (isAbsolute(outputDir) ? outputDir : join(project.root, outputDir));
  const skillName = task.skillName ?? task.type;
  const inputs = [...inputPaths].sort();
  const options = JSON.stringify(stable(task.options ?? {}), null, 2);

  return [
    `You are executing the ${skillName} stage for project ${project.id}.`,
    '',
    `Read the read-only Skill instructions at ${join(skillRoot, 'SKILL.md')} before doing any work.`,
    `Read any references and scripts required by that Skill from ${skillRoot}.`,
    `The writable project output directory is exactly ${outputRoot}.`,
    `The project root is ${project.root}; source and upstream artifacts are read-only inputs.`,
    '',
    'Inputs available to this task:',
    ...(inputs.length ? inputs.map((path) => `- ${path}`) : ['- none']),
    '',
    `Task options (JSON): ${options}`,
    '',
    'Required stage procedure (the Skill remains the source of truth):',
    ...stageProcedure(task, skillRoot, outputRoot, inputs).map((line, index) => `${index + 1}. ${line}`),
    '',
    'Execution contract:',
    '- Follow the original Skill workflow and its documented seed, model-writing, validate, render, and export commands where applicable.',
    '- Do not invent a replacement JSON schema or copy Skill rules into the workbench.',
    '- Do not modify any file under the repository skills/ directory or the read-only Skill snapshot.',
    `- Write generated files only under ${outputRoot}; keep report-relative media next to the Skill output it references.`,
    '- Do not invoke image generation during a text stage; image generation is a separate workbench task after the storyboard stage.',
    '- If a required input or quality gate is missing, report the exact failure and do not claim success.',
    '- End with a concise structured summary naming status, generated paths, validation result, and any assumptions.',
  ].join('\n');
}
