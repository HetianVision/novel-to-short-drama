import { join } from 'node:path';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function buildSkillPrompt({ task, project, skillSnapshot, inputPaths = [] }) {
  const skillRoot = typeof skillSnapshot === 'string' ? skillSnapshot : skillSnapshot?.root;
  if (!skillRoot) throw new Error('Skill snapshot root is required');
  const outputDir = task.outputDir ?? task.outputDirs?.[0] ?? task.type;
  const outputRoot = join(project.root, outputDir);
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
    'Execution contract:',
    '- Follow the original Skill workflow and its documented seed, model-writing, validate, render, and export commands where applicable.',
    '- Do not invent a replacement JSON schema or copy Skill rules into the workbench.',
    '- Do not modify any file under the repository skills/ directory or the read-only Skill snapshot.',
    `- Write generated files only under ${outputRoot}; keep report-relative media next to the Skill output it references.`,
    '- If a required input or quality gate is missing, report the exact failure and do not claim success.',
  ].join('\n');
}
