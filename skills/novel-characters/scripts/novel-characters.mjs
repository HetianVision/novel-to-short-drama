#!/usr/bin/env node
// novel-characters — deterministic helpers for the novel-characters skill.
// Zero dependencies on purpose: the skill must work in any directory
// without an npm install. Node 18+ (stdlib only).

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ */
/* chunk                                                               */
/* ------------------------------------------------------------------ */

export const CHUNK_SIZE = 14_000;
export const CHUNK_OVERLAP = 600;
export const MAX_CHUNKS = 24;

/**
 * Split source text on paragraph boundaries into overlapping chunks.
 * Overlap keeps a character introduced at a chunk seam visible to both sides.
 */
export function chunkText(text) {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_SIZE) return [clean];

  const chunks = [];
  let cursor = 0;

  while (cursor < clean.length && chunks.length < MAX_CHUNKS) {
    let end = Math.min(cursor + CHUNK_SIZE, clean.length);

    if (end < clean.length) {
      // Prefer a paragraph break, then a sentence end, inside the last 20%.
      const windowStart = cursor + Math.floor(CHUNK_SIZE * 0.8);
      const window = clean.slice(windowStart, end);
      const para = window.lastIndexOf('\n\n');
      const sentence = Math.max(
        window.lastIndexOf('。'),
        window.lastIndexOf('！'),
        window.lastIndexOf('？'),
        window.lastIndexOf('. '),
      );
      const offset = para >= 0 ? para : sentence;
      if (offset >= 0) end = windowStart + offset + 1;
    }

    chunks.push(clean.slice(cursor, end).trim());
    if (end >= clean.length) break;
    cursor = Math.max(end - CHUNK_OVERLAP, cursor + 1);
  }

  return chunks;
}

/* ------------------------------------------------------------------ */
/* merge                                                               */
/* ------------------------------------------------------------------ */

/**
 * Merge per-chunk rosters into one cast, keyed by name AND alias so that
 * 陆行远 / 陆 / 姑娘 collapse onto the same person regardless of which
 * chunk saw which form first.
 */
export function mergeRoster(batches) {
  const byKey = new Map();
  const keyOf = (s) => String(s).trim().toLowerCase();

  for (const batch of batches) {
    for (const entry of batch ?? []) {
      if (!entry?.name) continue;
      const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
      const candidates = [entry.name, ...aliases].map(keyOf).filter(Boolean);
      const existingKey = candidates.find((c) => byKey.has(c));
      const target = existingKey
        ? byKey.get(existingKey)
        : { name: String(entry.name).trim(), aliases: [], notes: [], quotes: [] };

      for (const alias of [entry.name, ...aliases]) {
        const trimmed = String(alias).trim();
        if (trimmed && trimmed !== target.name && !target.aliases.includes(trimmed)) {
          target.aliases.push(trimmed);
        }
      }
      if (entry.note && String(entry.note).trim()) target.notes.push(String(entry.note).trim());
      for (const quote of entry.quotes ?? []) {
        const trimmed = String(quote).trim();
        if (trimmed && !target.quotes.includes(trimmed)) target.quotes.push(trimmed);
      }

      for (const c of candidates) byKey.set(c, target);
    }
  }

  // Collapse the alias-keyed index back to one entry per character.
  const unique = new Map();
  for (const value of byKey.values()) unique.set(keyOf(value.name), value);
  // More chunks mentioning a character == more screen time.
  return [...unique.values()].sort((a, b) => b.notes.length - a.notes.length);
}

/* ------------------------------------------------------------------ */
/* slug                                                                */
/* ------------------------------------------------------------------ */

/** Filesystem-safe stem for a character name, CJK preserved. */
export function slug(name) {
  const cleaned = String(name)
    .trim()
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'character';
}

/* ------------------------------------------------------------------ */
/* i18n                                                                */
/* ------------------------------------------------------------------ */
/*
 * 报告语言。默认 zh。
 * 内置 zh / en 两套界面文案；给了其他语言码就用 en 的界面骨架，
 * 但角色内容仍按那个语言生成——界面词没翻译总比整篇乱掉强。
 */

export const DEFAULT_LANG = 'zh';

const STRINGS = {
  zh: {
    kicker: '角色设定集',
    titleTail: ' · 角色',
    docTitle: (s) => `${s} · 角色设定集`,
    counts: (n, shots) => `${n} 位角色${shots ? ` · ${shots} 张设定图` : ''} · 按戏份排序`,
    synopsis: '故事摘要',
    indexLabel: '角色索引',
    aka: '又称',
    groups: { persona: '画像', image: '形象', voice: '声音' },
    persona: {
      gender: '性别', ageRange: '年龄', identity: '身份',
      appearance: '外貌', temperament: '性情', motivation: '动机',
      arc: '人物弧光', relationships: '关系', evidence: '原文依据',
    },
    image: {
      style: '画风', copyTags: '复制标签',
      prompt: '出图提示词 EN', promptLocal: '出图提示词',
      negative: '反向提示词', turnaround: '三视图提示词 EN', face: '面部提示词 EN',
    },
    voice: {
      timbre: '音色', pitch: '音高', pace: '语速', accent: '口音',
      emotion: '情绪', referenceHint: '类比',
      prompt: '音色提示词 EN', promptLocal: '音色提示词',
    },
    importance: { protagonist: '主角', major: '主要角色', supporting: '配角', minor: '龙套' },
    copy: '复制', copied: '已复制', copyFailed: '复制失败', copyJson: '复制整份角色 JSON',
    turnaroundCaption: '三视图 · 正 侧 背（面部留空）',
    faceCaption: '面部细节',
    noImage: '尚未出图',
    noImageHint: '用下方提示词生成',
    colophonA: '画像与提示词由模型依据原文生成，',
    colophonB: '标记处为原文未明说、为可用性补全的内容。',
    mdTitle: (s) => `# ${s} — 角色表`,
    mdCast: (n, names) => `共 ${n} 位角色：${names}`,
    mdSynopsis: '## 故事摘要',
  },
  en: {
    kicker: 'CHARACTER BIBLE',
    titleTail: ' · Cast',
    docTitle: (s) => `${s} · Character Bible`,
    counts: (n, shots) =>
      `${n} character${n === 1 ? '' : 's'}${shots ? ` · ${shots} sheet${shots === 1 ? '' : 's'}` : ''} · ordered by prominence`,
    synopsis: 'Synopsis',
    indexLabel: 'Cast index',
    aka: 'a.k.a.',
    groups: { persona: 'Profile', image: 'Design', voice: 'Voice' },
    persona: {
      gender: 'Gender', ageRange: 'Age', identity: 'Standing',
      appearance: 'Appearance', temperament: 'Temperament', motivation: 'Motivation',
      arc: 'Arc', relationships: 'Relationships', evidence: 'From the text',
    },
    image: {
      style: 'Style', copyTags: 'Copy tags',
      prompt: 'Image prompt', promptLocal: 'Image prompt (local)',
      negative: 'Negative prompt', turnaround: 'Turnaround prompt', face: 'Face prompt',
    },
    voice: {
      timbre: 'Timbre', pitch: 'Pitch', pace: 'Pace', accent: 'Accent',
      emotion: 'Emotion', referenceHint: 'Sounds like',
      prompt: 'Voice prompt', promptLocal: 'Voice prompt (local)',
    },
    importance: { protagonist: 'Lead', major: 'Major', supporting: 'Supporting', minor: 'Minor' },
    copy: 'Copy', copied: 'Copied', copyFailed: 'Failed', copyJson: 'Copy full JSON',
    turnaroundCaption: 'Turnaround · front side back (face left blank)',
    faceCaption: 'Face detail',
    noImage: 'Not generated yet',
    noImageHint: 'use the prompts below',
    colophonA: 'Profiles and prompts are model-generated from the source text; ',
    colophonB: 'marks what the text does not state and was filled in for usability.',
    mdTitle: (s) => `# ${s} — Cast`,
    mdCast: (n, names) => `${n} characters: ${names}`,
    mdSynopsis: '## Synopsis',
  },
  ja: {
    kicker: 'キャラクター設定集',
    titleTail: ' · 登場人物',
    docTitle: (s) => `${s} · キャラクター設定集`,
    counts: (n, shots) => `${n}人${shots ? ` · 設定画 ${shots}枚` : ''} · 出番順`,
    synopsis: 'あらすじ',
    indexLabel: '登場人物一覧',
    aka: '別名',
    groups: { persona: '人物像', image: 'ビジュアル', voice: '声' },
    persona: {
      gender: '性別', ageRange: '年齢', identity: '立場',
      appearance: '外見', temperament: '性格', motivation: '動機',
      arc: '人物の変化', relationships: '関係', evidence: '原文の根拠',
    },
    image: {
      style: '画風', copyTags: 'タグをコピー',
      prompt: '画像プロンプト EN', promptLocal: '画像プロンプト',
      negative: 'ネガティブプロンプト', turnaround: '三面図プロンプト EN', face: '顔プロンプト EN',
    },
    voice: {
      timbre: '声質', pitch: '音域', pace: '話速', accent: '訛り',
      emotion: '感情', referenceHint: 'たとえるなら',
      prompt: '音声プロンプト EN', promptLocal: '音声プロンプト',
    },
    importance: { protagonist: '主役', major: '主要人物', supporting: '脇役', minor: '端役' },
    copy: 'コピー', copied: 'コピー済み', copyFailed: '失敗', copyJson: 'JSON をコピー',
    turnaroundCaption: '三面図 · 正面 側面 背面（顔は空白）',
    faceCaption: '顔の詳細',
    noImage: '未生成',
    noImageHint: '下のプロンプトで生成',
    colophonA: '人物像とプロンプトは原文をもとにモデルが生成したものです。',
    colophonB: 'の箇所は原文に明記がなく、実用のために補ったものです。',
    mdTitle: (s) => `# ${s} — 登場人物`,
    mdCast: (n, names) => `全${n}人：${names}`,
    mdSynopsis: '## あらすじ',
  },
};

/**
 * 取界面文案。
 *
 * 两层：内置表覆盖常用语言；其他语言由 skill 在生成时翻译一份塞进
 * cast.json 的 `ui`，这里合并进来。这样支持的语言不受内置表限制。
 *
 * @param lang      语言码
 * @param overrides cast.json 的 `ui`，可以只覆盖一部分键
 */
export function strings(lang = DEFAULT_LANG, overrides = null) {
  const base = STRINGS[lang] ?? STRINGS.en;
  if (!overrides || typeof overrides !== 'object') return base;

  // 只合两层——STRINGS 的嵌套就两层深，够用且不会被脏数据带偏。
  const merged = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof base[k] === 'function') continue; // 函数模板不接受覆盖
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      merged[k] = { ...base[k], ...v };
    } else if (typeof v === 'string') {
      merged[k] = v;
    }
  }
  return merged;
}

export const SUPPORTED_UI_LANGS = Object.keys(STRINGS);

/** 需要 skill 补一份 `ui` 翻译的语言（内置表里没有的）。 */
export const needsUiTranslation = (lang) => !SUPPORTED_UI_LANGS.includes(lang);

/** `ui` 里可覆盖的键——供 ui-template 子命令生成骨架。 */
export function uiTemplate() {
  const en = STRINGS.en;
  const out = {};
  for (const [k, v] of Object.entries(en)) {
    if (typeof v === 'function') continue;
    out[k] = v && typeof v === 'object' ? { ...v } : v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* validate                                                            */
/* ------------------------------------------------------------------ */

const IMPORTANCE = ['protagonist', 'major', 'supporting', 'minor'];
/** 中日韩表意文字与假名、谚文——图像/TTS 提示词里出现就说明串语言了。 */
const CJK = /[㐀-鿿぀-ヿ가-힯]/;
/** 假名单独一条：用来把日文和中文区分开。 */
const KANA = /[぀-ヿ]/;

const PERSONA_STRINGS = ['gender', 'ageRange', 'identity', 'appearance', 'temperament', 'motivation', 'arc'];
/** 机器输入，永远英文——图像和 TTS 引擎都吃英文最稳，跟报告语言无关。 */
const MACHINE_FIELDS = { image: ['prompt', 'negativePrompt', 'turnaround', 'face'], voice: ['prompt'] };
/** 给人读的，跟随报告语言。 */
const HUMAN_VOICE_FIELDS = ['timbre', 'pitch', 'pace', 'accent', 'emotion', 'referenceHint'];

const normalise = (s) => String(s).replace(/\s+/g, '');

/**
 * @param characters 角色卡数组
 * @param sourceText 原文；null 则跳过逐字引文校验
 * @param lang       报告语言，决定人类可读字段该是什么语言
 */
export function validateCast(characters, sourceText, lang = DEFAULT_LANG) {
  const problems = [];
  const flatSource = sourceText === null ? null : normalise(sourceText);
  const at = (name, msg) => problems.push(`[${name}] ${msg}`);

  if (!Array.isArray(characters) || characters.length === 0) {
    return ['cast 为空或不是数组'];
  }

  for (const c of characters) {
    const name = c?.name ?? '(无名)';

    // --- 结构 ---
    if (typeof c?.name !== 'string' || !c.name.trim()) at(name, '缺少 name');
    if (!Array.isArray(c?.aliases)) at(name, 'aliases 必须是数组');
    if (!IMPORTANCE.includes(c?.importance)) {
      at(name, `importance 必须是 ${IMPORTANCE.join('/')}，实际是 ${JSON.stringify(c?.importance)}`);
    }
    if (typeof c?.oneLiner !== 'string' || !c.oneLiner.trim()) at(name, '缺少 oneLiner');

    const persona = c?.persona;
    if (!persona || typeof persona !== 'object') {
      at(name, '缺少 persona');
    } else {
      for (const f of PERSONA_STRINGS) {
        if (typeof persona[f] !== 'string' || !persona[f].trim()) at(name, `persona.${f} 缺失或为空`);
      }
      if (!Array.isArray(persona.personality)) at(name, 'persona.personality 必须是数组');
      if (!Array.isArray(persona.relationships)) at(name, 'persona.relationships 必须是数组');
      if (!Array.isArray(persona.evidence)) at(name, 'persona.evidence 必须是数组');
    }

    const image = c?.image;
    if (!image || typeof image !== 'object') {
      at(name, '缺少 image');
    } else {
      for (const f of ['style', 'prompt', 'negativePrompt']) {
        if (typeof image[f] !== 'string' || !image[f].trim()) at(name, `image.${f} 缺失或为空`);
      }
      if (typeof image.turnaround !== 'string' || !image.turnaround.trim()) {
        at(name, 'image.turnaround 缺失或为空（三视图提示词）');
      }
      if (typeof image.face !== 'string' || !image.face.trim()) {
        at(name, 'image.face 缺失或为空（面部细节提示词）');
      }
      if (!Array.isArray(image.tags)) at(name, 'image.tags 必须是数组');
    }

    const voice = c?.voice;
    if (!voice || typeof voice !== 'object') {
      at(name, '缺少 voice');
    } else {
      for (const f of [...HUMAN_VOICE_FIELDS, 'prompt']) {
        if (typeof voice[f] !== 'string' || !voice[f].trim()) at(name, `voice.${f} 缺失或为空`);
      }
    }

    // --- 引文必须逐字 ---
    if (flatSource && Array.isArray(persona?.evidence)) {
      for (const quote of persona.evidence) {
        if (typeof quote !== 'string') {
          at(name, 'persona.evidence 里有非字符串');
        } else if (!flatSource.includes(normalise(quote))) {
          at(name, `引文不是原文逐字片段：${quote}`);
        }
      }
    }

    // --- 出图提示词不许出现人名 ---
    if (image) {
      const names = [c?.name, ...(Array.isArray(c?.aliases) ? c.aliases : [])].filter(
        (n) => typeof n === 'string' && n.trim(),
      );
      for (const field of ['prompt', 'promptLocal', 'turnaround', 'face']) {
        const value = image[field];
        if (typeof value !== 'string') continue;
        for (const n of names) {
          if (value.includes(n)) at(name, `image.${field} 里出现了人名「${n}」`);
        }
      }
    }

    // --- 语言分工 ---
    // 机器字段永远英文；人类字段跟随报告语言。
    // 只有 zh / en 能可靠自动判别，其他语言不猜、跳过。
    for (const [group, fields] of Object.entries(MACHINE_FIELDS)) {
      const obj = c?.[group];
      if (!obj) continue;
      for (const f of fields) {
        if (typeof obj[f] === 'string' && CJK.test(obj[f])) {
          at(name, `${group}.${f} 是喂给模型的，必须英文，但含中日韩字符`);
        }
      }
    }
    if (Array.isArray(image?.tags)) {
      for (const t of image.tags) {
        if (typeof t === 'string' && CJK.test(t)) at(name, `image.tags 必须英文，但「${t}」含中日韩字符`);
      }
    }
    // 只有这三种能可靠自动判别，其他语言不猜、跳过——误报比漏报更烦人。
    if (voice) {
      for (const f of HUMAN_VOICE_FIELDS) {
        const v = voice[f];
        if (typeof v !== 'string' || !v.trim()) continue;
        if (lang === 'en' && CJK.test(v)) at(name, `voice.${f} 应为英文，但含中日韩字符`);
        if (lang === 'zh' && !CJK.test(v)) at(name, `voice.${f} 应为中文，实际是「${v}」`);
        if (lang === 'zh' && KANA.test(v)) at(name, `voice.${f} 应为中文，但含日文假名`);
        if (lang === 'ja' && !KANA.test(v) && !CJK.test(v)) {
          at(name, `voice.${f} 应为日文，实际是「${v}」`);
        }
      }
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* render — markdown                                                   */
/* ------------------------------------------------------------------ */

export function renderMarkdown(characters, source, summary = '', lang = DEFAULT_LANG, ui = null) {
  const t = strings(lang, ui);
  const out = [t.mdTitle(source), '', t.mdCast(characters.length, characters.map((c) => c.name).join('、')), ''];
  if (summary) out.push(t.mdSynopsis, '', summary, '');

  for (const c of characters) {
    const { persona, image, voice } = c;
    out.push('---', '');
    out.push(`## ${c.name}${c.aliases.length ? `（${c.aliases.join('、')}）` : ''}`, '');
    out.push(`> ${t.importance[c.importance] ?? c.importance} · ${c.oneLiner}`, '');

    if (c.faceImage) out.push(`![${c.name} ${t.faceCaption}](${c.faceImage})`, '');
    if (c.turnaroundImage) out.push(`![${c.name} ${t.turnaroundCaption}](${c.turnaroundImage})`, '');

    out.push(`### ${t.groups.persona}`, '');
    out.push(`- **${t.persona.gender}**：${persona.gender}`);
    out.push(`- **${t.persona.ageRange}**：${persona.ageRange}`);
    out.push(`- **${t.persona.identity}**：${persona.identity}`);
    if (persona.personality.length) out.push(`- ${persona.personality.join(' / ')}`);
    out.push('');
    out.push(`**${t.persona.appearance}**　${persona.appearance}`, '');
    out.push(`**${t.persona.temperament}**　${persona.temperament}`, '');
    out.push(`**${t.persona.motivation}**　${persona.motivation}`, '');
    out.push(`**${t.persona.arc}**　${persona.arc}`, '');

    if (persona.relationships.length) {
      out.push(`**${t.persona.relationships}**`, '');
      for (const r of persona.relationships) out.push(`- ${r.name} — ${r.relation}`);
      out.push('');
    }
    if (persona.evidence.length) {
      out.push(`**${t.persona.evidence}**`, '');
      for (const q of persona.evidence) out.push(`> ${q}`, '');
    }

    out.push(`### ${t.groups.image}`, '');
    out.push(`**${t.image.style}**　${image.style}`, '');
    if (image.tags.length) out.push(`\`${image.tags.join('`, `')}\``, '');
    out.push(`**${t.image.prompt}**`, '', '```text', image.prompt, '```', '');
    if (image.promptLocal) out.push(`${image.promptLocal}`, '');
    out.push(`**${t.image.negative}**`, '', '```text', image.negativePrompt, '```', '');
    out.push(`**${t.image.face}**`, '', '```text', image.face, '```', '');
    out.push(`**${t.image.turnaround}**`, '', '```text', image.turnaround, '```', '');

    out.push(`### ${t.groups.voice}`, '');
    for (const f of HUMAN_VOICE_FIELDS) out.push(`- **${t.voice[f]}**：${voice[f]}`);
    out.push('');
    out.push(`**${t.voice.prompt}**`, '', '```text', voice.prompt, '```', '');
    if (voice.promptLocal) out.push(`${voice.promptLocal}`, '');
  }

  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* render — html                                                       */
/* ------------------------------------------------------------------ */
/*
 * 设计约定见 references/report-style.md。四条不能破的：
 *   1. 双字域：衬线=叙事与原文，无衬线=分析，等宽=喂给机器的提示词
 *   2. 不藏内容——没有页签、没有折叠，整页可以 Cmd+F
 *   3. 「（推断）」自动高亮，让读者一眼分清有据和补全
 *   4. 页宽 1800、一排最多三个角色（靠 minmax 卡住，三个数联动）
 */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 推断标记：半角/全角 × 中英四种写法都要认，模型不挑食地乱产。 */
const INFERRED = /（\s*(?:推断|inferred)[^）]*）|\(\s*(?:推断|inferred)[^)]*\)/gi;
const marked = (s) => esc(s).replace(INFERRED, (m) => `<span class="inf">${m}</span>`);

const IMPORTANCE_ORDER = ['protagonist', 'major', 'supporting', 'minor'];

function renderEntry(c, index, t) {
  const { persona, image, voice } = c;
  const rank = String(index + 1).padStart(2, '0');

  const promptBlock = (label, value, cls = 'mono') =>
    !value
      ? ''
      : `<div class="pb">
<div class="pb-h"><span class="pb-l">${esc(label)}</span><button class="copy" data-copy="${esc(value)}">${esc(t.copy)}</button></div>
<p class="${cls}">${esc(value)}</p>
</div>`;
  const row = (label, value) =>
    !value ? '' : `<div class="row"><dt>${esc(label)}</dt><dd>${marked(value)}</dd></div>`;
  const para = (label, body) =>
    !body ? '' : `<div class="para"><h4>${esc(label)}</h4><p>${marked(body)}</p></div>`;

  const plate = (src, caption, alt) =>
    `<a class="plate" href="${esc(src)}" target="_blank" rel="noopener">
       <img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">
       <span class="plate-c">${esc(caption)}</span>
     </a>`;

  const sheets =
    c.faceImage || c.turnaroundImage
      ? `<div class="sheets">
           ${c.faceImage ? plate(c.faceImage, t.faceCaption, `${c.name} ${t.faceCaption}`) : ''}
           ${c.turnaroundImage ? plate(c.turnaroundImage, t.turnaroundCaption, `${c.name} ${t.turnaroundCaption}`) : ''}
         </div>`
      : `<div class="plate plate-empty"><span>${esc(t.noImage)}<br><em>${esc(t.noImageHint)}</em></span></div>`;

  return `<article class="entry" id="p-${slug(c.name)}">
  <header class="entry-h">
    <span class="rank">${rank}</span>
    <h2 class="name">${esc(c.name)}</h2>
    <span class="tag tag-${esc(c.importance)}">${esc(t.importance[c.importance] ?? c.importance)}</span>
    ${c.aliases.length ? `<span class="aka">${esc(t.aka)} ${esc(c.aliases.join(' · '))}</span>` : ''}
  </header>
  <p class="oneliner">${marked(c.oneLiner)}</p>

  ${sheets}

  <div class="groups">
    <section class="group">
      <h3 class="group-h">${esc(t.groups.persona)}</h3>
      <dl class="rows">
        ${row(t.persona.gender, persona.gender)}${row(t.persona.ageRange, persona.ageRange)}${row(t.persona.identity, persona.identity)}
      </dl>
      ${persona.personality.length ? `<ul class="traits">${persona.personality.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${para(t.persona.appearance, persona.appearance)}
      ${para(t.persona.temperament, persona.temperament)}
      ${para(t.persona.motivation, persona.motivation)}
      ${para(t.persona.arc, persona.arc)}
      ${
        persona.relationships.length
          ? `<div class="para"><h4>${esc(t.persona.relationships)}</h4><dl class="rows">${persona.relationships
              .map((r) => `<div class="row"><dt>${esc(r.name)}</dt><dd>${marked(r.relation)}</dd></div>`)
              .join('')}</dl></div>`
          : ''
      }
      ${
        persona.evidence.length
          ? `<div class="source"><h4>${esc(t.persona.evidence)}</h4>${persona.evidence
              .map((q) => `<blockquote>${esc(q)}</blockquote>`)
              .join('')}</div>`
          : ''
      }
    </section>

    <section class="group">
      <h3 class="group-h">${esc(t.groups.image)}</h3>
      ${row(t.image.style, image.style)}
      ${
        image.tags.length
          ? `<div class="tagrow"><ul class="tags">${image.tags.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><button class="copy" data-copy="${esc(image.tags.join(', '))}">${esc(t.image.copyTags)}</button></div>`
          : ''
      }
      ${promptBlock(t.image.prompt, image.prompt)}
      ${promptBlock(t.image.promptLocal, image.promptLocal, 'local')}
      ${promptBlock(t.image.negative, image.negativePrompt)}
      ${promptBlock(t.image.face, image.face)}
      ${promptBlock(t.image.turnaround, image.turnaround)}
    </section>

    <section class="group">
      <h3 class="group-h">${esc(t.groups.voice)}</h3>
      <dl class="rows">
        ${HUMAN_VOICE_FIELDS.map((f) => row(t.voice[f], voice[f])).join('')}
      </dl>
      ${promptBlock(t.voice.prompt, voice.prompt)}
      ${promptBlock(t.voice.promptLocal, voice.promptLocal, 'local')}
      <div class="entry-f">
        <button class="copy" data-copy="${esc(JSON.stringify(c, null, 2))}">${esc(t.copyJson)}</button>
      </div>
    </section>
  </div>
</article>`;
}

export function renderHtml(characters, source, summary = '', lang = DEFAULT_LANG, ui = null) {
  const t = strings(lang, ui);
  const shots = characters.filter((c) => c.turnaroundImage || c.faceImage).length;
  const ordered = [...characters].sort(
    (a, b) => IMPORTANCE_ORDER.indexOf(a.importance) - IMPORTANCE_ORDER.indexOf(b.importance),
  );

  const index = ordered
    .map(
      (c, i) => `<li style="--i:${i}">
        <a href="#p-${slug(c.name)}">
          <span class="ix-n">${String(i + 1).padStart(2, '0')}</span>
          <span class="ix-name">${esc(c.name)}</span>
          <span class="ix-rule"></span>
          <span class="ix-tag">${esc(t.importance[c.importance] ?? c.importance)}</span>
        </a></li>`,
    )
    .join('');

  return `<!doctype html>
<html lang="${esc(lang)}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.docTitle(source))}</title>
<style>
/* 冷灰印张 + 铁锈红印记。红色只用在与原文有关的地方。 */
:root{
  --paper:#e9eae5; --panel:#e1e3dd; --ink:#191d21; --ink-2:#5b636a; --ink-3:#8c9298;
  --rule:#cdd0c9; --seal:#8a3324; --seal-soft:#8a332412;
  --serif:"Songti SC","STSong","Source Han Serif SC","Noto Serif CJK SC",Georgia,"Iowan Old Style",serif;
  --sans:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
@media(prefers-color-scheme:dark){
  :root{
    --paper:#14171a; --panel:#1c2024; --ink:#e6e8e4; --ink-2:#9aa1a7; --ink-3:#6d757c;
    --rule:#2c3237; --seal:#c96a4f; --seal-soft:#c96a4f16;
  }
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.75 var(--sans);
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1800px;margin:0 auto;padding:clamp(32px,5vw,64px) clamp(20px,3vw,40px) 96px}

/* ---- 头 ---- */
.masthead{border-bottom:2px solid var(--ink);padding-bottom:20px}
.eyebrow{font:500 11px/1 var(--sans);letter-spacing:.28em;text-transform:uppercase;color:var(--ink-3);margin:0 0 14px}
.title{font:400 clamp(34px,6vw,58px)/1.1 var(--serif);margin:0;letter-spacing:.02em}
.title em{font-style:normal;color:var(--ink-3)}
.meta{margin:14px 0 0;font-size:13px;color:var(--ink-2)}
.meta b{font-weight:500;color:var(--ink)}

/* ---- 摘要 + 目录并排，把 1800px 的宽度用起来 ---- */
.brief{display:grid;gap:40px;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);
  align-items:start;margin-top:28px}
@media(max-width:1100px){.brief{grid-template-columns:1fr;gap:24px}}

/* 摘要说的是故事本身，用叙事字域 */
.synopsis{padding:22px 26px;background:var(--panel);border:1px solid var(--rule);
  border-radius:2px;border-left:2px solid var(--ink)}
.synopsis h2{font:500 11px/1 var(--sans);letter-spacing:.28em;color:var(--ink-3);margin:0 0 10px}
.synopsis p{margin:0;font:400 clamp(15px,1.1vw,16.5px)/1.95 var(--serif)}

/* ---- 目录：戏份排序，序号是排名不是装饰 ---- */
.index{margin:0;padding:0;list-style:none}
.index li{border-bottom:1px solid var(--rule);animation:rise .5s both;animation-delay:calc(var(--i)*45ms)}
.index a{display:flex;align-items:baseline;gap:14px;padding:11px 2px;text-decoration:none;color:inherit}
.index a:hover .ix-name{color:var(--seal)}
.ix-n{font:500 11px/1 var(--mono);color:var(--ink-3);width:20px;flex:none}
.ix-name{font:400 21px/1.2 var(--serif);letter-spacing:.03em;transition:color .15s}
.ix-rule{flex:1;border-bottom:1px dotted var(--rule);transform:translateY(-4px)}
.ix-tag{font-size:12px;color:var(--ink-2);flex:none}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

/* ---- 角色墙：一排最多三个 ----
   minmax 下限 460px 配 1800px 上限，天然卡在三列：
   3×460+2×28=1436 装得下，4×460+3×28=1924 装不下。 */
.cast{display:grid;gap:28px;grid-template-columns:repeat(auto-fit,minmax(460px,1fr));
  align-items:start;margin-top:40px}

/* ---- 条目 ---- */
.entry{border:1px solid var(--rule);border-radius:2px;background:var(--panel);
  padding:24px;scroll-margin-top:24px}
.entry-h{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.rank{font:500 12px/1 var(--mono);color:var(--ink-3)}
.name{font:400 clamp(24px,2.2vw,32px)/1.15 var(--serif);margin:0;letter-spacing:.04em}
.tag{font-size:12px;padding:2px 9px;border:1px solid var(--rule);border-radius:2px;color:var(--ink-2)}
.tag-protagonist{border-color:var(--seal);color:var(--seal)}
.aka{font-size:13px;color:var(--ink-3)}
.oneliner{font:400 15.5px/1.75 var(--serif);color:var(--ink-2);margin:12px 0 24px}

/* ---- 设定图：面部细节 + 三视图 ---- */
.sheets{display:flex;flex-direction:column;gap:12px;margin-bottom:28px}
/* 白底的印张，深色模式下也保持白底——它是一张纸，不是 UI 面板 */
.plate{display:block;position:relative;background:#fff;border:1px solid var(--rule);
  border-radius:2px;overflow:hidden}
.plate img{display:block;width:100%;height:auto}
.plate-c{position:absolute;left:0;bottom:0;background:var(--paper);border-top:1px solid var(--rule);
  border-right:1px solid var(--rule);padding:5px 12px;font:500 11px/1 var(--sans);
  letter-spacing:.14em;color:var(--ink-2)}
.plate-empty{display:grid;place-items:center;min-height:160px;text-align:center;
  color:var(--ink-3);font-size:13px;background:var(--paper);margin-bottom:28px}
.plate-empty em{font-style:normal;font-size:12px;opacity:.75}

/* ---- 卡内三组竖排：画像 → 形象 → 声音 ---- */
.groups{display:block}
.group{margin-top:30px}
.group:first-child{margin-top:0}
.group-h{font:500 11px/1 var(--sans);letter-spacing:.28em;text-transform:uppercase;color:var(--ink-3);
  margin:0 0 16px;padding-bottom:8px;border-bottom:1px solid var(--rule)}
.rows{margin:0 0 16px}
.row{display:flex;gap:14px;padding:3px 0;font-size:14px}
.row dt{color:var(--ink-3);flex:none;min-width:52px}
.row dd{margin:0}
.traits{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 18px;padding:0;list-style:none}
.traits li{border:1px solid var(--rule);background:var(--paper);border-radius:2px;padding:2px 9px;font-size:13px}
.para{margin-bottom:18px}
.para h4,.source h4{font:500 11px/1 var(--sans);letter-spacing:.2em;color:var(--ink-3);margin:0 0 6px}
.para p{margin:0;font-size:14px;line-height:1.8}

/* ---- 签名：推断标记 ---- */
.inf{color:var(--ink-3);font-size:.88em;background:var(--seal-soft);padding:0 3px;border-radius:2px}

/* ---- 原文：衬线体，铁锈红边栏。这里是书自己在说话 ---- */
.source{border-left:2px solid var(--seal);padding-left:16px;margin-top:22px}
.source blockquote{margin:0 0 10px;font:400 14.5px/1.85 var(--serif);color:var(--ink)}
.source blockquote:last-child{margin-bottom:0}
.source blockquote::before{content:"「";color:var(--seal)}
.source blockquote::after{content:"」";color:var(--seal)}

/* ---- 提示词：等宽，机器的输入 ---- */
.tagrow{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:18px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.tags li{font:400 12px/1.5 var(--mono);color:var(--ink-2);border:1px solid var(--rule);
  background:var(--paper);border-radius:2px;padding:1px 7px}
.pb{border:1px solid var(--rule);border-radius:2px;background:var(--paper);margin-bottom:14px}
.pb-h{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 11px;
  border-bottom:1px solid var(--rule)}
.pb-l{font:500 10px/1 var(--sans);letter-spacing:.18em;text-transform:uppercase;color:var(--ink-3)}
.pb p{margin:0;padding:11px;white-space:pre-wrap;word-break:break-word}
.pb .mono{font:400 12.5px/1.7 var(--mono)}
.pb .local{font:400 14px/1.8 var(--sans)}

.copy{flex:none;font:500 11px/1 var(--sans);color:var(--ink-2);background:transparent;
  border:1px solid var(--rule);border-radius:2px;padding:4px 10px;cursor:pointer;transition:.15s}
.copy:hover{border-color:var(--seal);color:var(--seal)}
.copy:focus-visible{outline:2px solid var(--seal);outline-offset:2px}
.copy[data-done]{border-color:var(--seal);color:var(--seal)}
.entry-f{margin-top:20px;padding-top:16px;border-top:1px solid var(--rule)}
.entry-f .copy{width:100%;padding:9px}

.colophon{margin-top:72px;padding-top:20px;border-top:2px solid var(--ink);
  font-size:12px;color:var(--ink-3);display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}

@media(max-width:640px){
  .cast{gap:20px;grid-template-columns:1fr}
  .entry{padding:18px}
  .index a{gap:10px}
  .ix-name{font-size:18px}
}
@media(prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
  html{scroll-behavior:auto}
}
@media print{
  .copy,.index{display:none}
  .entry{page-break-inside:avoid;border:none;border-top:1px solid #000;background:none}
  body{background:#fff}
  .cast{display:block}
}
</style></head><body>
<div class="wrap">

<header class="masthead">
  <p class="eyebrow">${esc(t.kicker)}</p>
  <h1 class="title">${esc(source)}<em>${esc(t.titleTail)}</em></h1>
  <p class="meta">${esc(t.counts(characters.length, shots))}</p>
</header>

<div class="brief">
${summary ? `<section class="synopsis"><h2>${esc(t.synopsis)}</h2><p>${marked(summary)}</p></section>` : ''}
<nav aria-label="${esc(t.indexLabel)}"><ol class="index">${index}</ol></nav>
</div>

<div class="cast">
${ordered.map((c, i) => renderEntry(c, i, t)).join('\n')}
</div>

<footer class="colophon">
  <span>${esc(t.colophonA)}<span class="inf">${lang === 'zh' ? '（推断）' : '(inferred)'}</span>${esc(t.colophonB)}</span>
  <span>novel-characters</span>
</footer>

</div>
<script>
const L = ${JSON.stringify({ copied: t.copied, failed: t.copyFailed })};
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy');
  if (!btn) return;
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    btn.textContent = L.copied;
    btn.dataset.done = '1';
  } catch {
    btn.textContent = L.failed;
  }
  setTimeout(() => { btn.textContent = label; delete btn.dataset.done; }, 1600);
});
</script>
</body></html>`;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const USAGE = `novel-characters.mjs — novel-characters skill 的确定性工具

  chunk <book.txt> <workdir>       段落感知重叠切块，写 chunk-NN.txt，打印块数
  merge <workdir>                  归并 roster-*.json，打印 cast JSON
  validate <cast.json> <book.txt>  校验；有违规逐条打印并 exit 1
  render <cast.json> [--html|--md] 渲染报告到 stdout（默认 --md）
  slug <name>                      角色名转安全文件名
  ui-template [lang]               打印界面文案骨架，供翻译成内置表没有的语言

通用选项：
  --lang <code>     报告语言，默认取 cast.json 的 lang，再默认 ${DEFAULT_LANG}
                    内置界面文案：${SUPPORTED_UI_LANGS.join(' / ')}；其他语言码用英文界面骨架

render 选项：
  --source <name>   报告标题用的书名（默认取 cast.json 的 source 或文件名）
  --images <dir>    图片目录名，默认 images
                    会去找 <dir>/<slug>-face.png 和 <dir>/<slug>-turnaround.png`;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

/** 取 --flag 的值，没有就返回 fallback。 */
function flag(rest, name, fallback = null) {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
}

/** cast.json 可以是 {source, lang, summary, characters}，也可以是裸数组（旧格式）。 */
function loadCast(path) {
  const raw = readJson(path);
  const characters = Array.isArray(raw) ? raw : raw.characters;
  if (!Array.isArray(characters)) throw new Error(`${path} 里没有 characters 数组`);
  return {
    characters,
    source: Array.isArray(raw) ? null : raw.source,
    summary: Array.isArray(raw) ? '' : (raw.summary ?? ''),
    lang: Array.isArray(raw) ? DEFAULT_LANG : (raw.lang ?? DEFAULT_LANG),
    ui: Array.isArray(raw) ? null : (raw.ui ?? null),
  };
}

function main(argv) {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === 'chunk') {
    const [book, workdir] = rest;
    if (!book || !workdir) throw new Error('用法：chunk <book.txt> <workdir>');
    const text = readFileSync(resolve(book), 'utf8');
    const chunks = chunkText(text);
    mkdirSync(resolve(workdir), { recursive: true });
    chunks.forEach((c, i) => {
      writeFileSync(join(resolve(workdir), `chunk-${String(i).padStart(2, '0')}.txt`), c, 'utf8');
    });
    const truncated = chunks.length >= MAX_CHUNKS && text.length > CHUNK_SIZE * MAX_CHUNKS;
    console.log(
      JSON.stringify(
        { chunks: chunks.length, chars: text.length, workdir: resolve(workdir), truncated },
        null,
        2,
      ),
    );
    if (truncated) console.error(`⚠️ 文本超过 ${MAX_CHUNKS} 块上限，尾部未扫描`);
    return;
  }

  if (cmd === 'merge') {
    const [workdir] = rest;
    if (!workdir) throw new Error('用法：merge <workdir>');
    const dir = resolve(workdir);
    const files = readdirSync(dir).filter((f) => /^roster-.*\.json$/.test(f)).sort();
    if (!files.length) throw new Error(`${dir} 里没有 roster-*.json`);
    const batches = files.map((f) => {
      const raw = readJson(join(dir, f));
      return Array.isArray(raw) ? raw : (raw.characters ?? []);
    });
    console.log(JSON.stringify(mergeRoster(batches), null, 2));
    return;
  }

  if (cmd === 'validate') {
    const [castPath, bookPath] = rest;
    if (!castPath) throw new Error('用法：validate <cast.json> <book.txt>');
    const { characters, summary, lang: castLang, ui } = loadCast(castPath);
    const lang = flag(rest, '--lang', castLang);
    const source = bookPath ? readFileSync(resolve(bookPath), 'utf8') : null;
    if (!bookPath) console.error('⚠️ 没给原文，跳过逐字引文校验');
    const problems = validateCast(characters, source, lang);
    // 顶层的故事摘要——报告要用，缺了就没法在顶部交代背景
    if (typeof summary !== 'string' || !summary.trim()) {
      problems.unshift('顶层缺少 summary（故事摘要），报告顶部会空着');
    }
    // 内置表没有这个语言，又没给 ui 翻译 —— 报告界面会露出英文
    if (needsUiTranslation(lang) && !ui) {
      problems.unshift(
        `lang=${lang} 不在内置界面语言（${SUPPORTED_UI_LANGS.join('/')}）里，` +
          '顶层需要一份 ui 翻译，否则界面文案会是英文。' +
          '用 `ui-template` 生成骨架后翻译填进去。',
      );
    }
    if (problems.length) {
      console.error(`✗ ${problems.length} 处违规：\n`);
      for (const p of problems) console.error('  ' + p);
      process.exit(1);
    }
    console.log(`✓ ${characters.length} 个角色全部通过校验（lang=${lang}）`);
    return;
  }

  if (cmd === 'render') {
    const [castPath] = rest;
    if (!castPath) throw new Error('用法：render <cast.json> [--html|--md]');
    const html = rest.includes('--html');
    const imagesDir = flag(rest, '--images', 'images');
    const sourceFlag = flag(rest, '--source');

    const { characters, source, summary, lang: castLang, ui } = loadCast(castPath);
    const lang = flag(rest, '--lang', castLang);
    const title = sourceFlag ?? source ?? basename(castPath).replace(/\.[^.]+$/, '');

    // 图存在才挂上去：面部细节图和三视图各自独立，缺哪张都不影响另一张。
    const outDir = resolve(castPath, '..');
    for (const c of characters) {
      const stem = `${imagesDir}/${slug(c.name)}`;
      if (existsSync(join(outDir, `${stem}-face.png`))) c.faceImage = `${stem}-face.png`;
      if (existsSync(join(outDir, `${stem}-turnaround.png`))) c.turnaroundImage = `${stem}-turnaround.png`;
    }

    process.stdout.write(
      (html
        ? renderHtml(characters, title, summary, lang, ui)
        : renderMarkdown(characters, title, summary, lang, ui)) + '\n',
    );
    return;
  }

  if (cmd === 'ui-template') {
    const lang = rest[0] ?? '<lang>';
    console.log(
      JSON.stringify(
        { note: `把下面每个值翻译成 ${lang}，整块放进 cast.json 的顶层 "ui"`, ui: uiTemplate() },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === 'slug') {
    if (!rest[0]) throw new Error('用法：slug <name>');
    console.log(slug(rest[0]));
    return;
  }

  throw new Error(`未知命令 ${cmd}\n\n${USAGE}`);
}

// 只有直接运行才跑 CLI —— selftest.mjs 需要 import 这些函数。
// 两边都取 realpath：软链安装时 argv[1] 是链接路径，而 import.meta.url
// 已被 Node 解析成真实路径，不归一化就永远不相等。
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
