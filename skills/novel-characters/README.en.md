[中文](README.md) · **English**

# novel-characters

Feed it a novel or a short story, and get a complete design bible for every character:

- **Cast list** — who appears, how central they are, with every name a character is called by folded into one person
- **Profile** — gender, age, standing, appearance, temperament, motivation, arc, relationships, each backed by **verbatim quotes from the source**
- **Cartoon-design prompts** — bilingual image prompt + negative prompt + style tags, ready for Midjourney / SD / GPT-Image
- **Voice prompts** — timbre, pitch, pace, accent, emotion, plus a voice-design prompt for Qwen3-TTS / ElevenLabs Voice Design
- **A character model sheet** — one image: an ID-photo-style bust on the left with the face fully drawn, and a full-body turnaround filling the right ~62% with **the faces deliberately left blank**. White background for clean cut-out, generated through codex's built-in image tool (optional)

Outputs `cast.json`, a Markdown report, and a self-contained `report.html` you can just double-click.

**Any output language**, Chinese by default:

```
/novel-characters ./book.txt --lang en
/novel-characters ./book.txt --lang ja
```

Chinese, English and Japanese UI strings ship built in. **Other languages work too** — the skill translates the UI labels on the fly into the target language and stores them in `cast.json` under `ui`, so French, Korean or Spanish reports come out fully localized rather than half-English.

![report.html](assets/report.png)

A character model sheet (Shen Zhiwei, from the bundled sample story):

![model sheet](assets/sheet.jpg)

## Use

For installation see the [repository README](../../README.en.md). Then:

```
/novel-characters ./your-novel.txt
```

Or just say "break this book down into characters" and give it the path.

## How it works

Feeding a long text into one context window loses characters, so it runs in two passes:

**Pass 1 — scan** (cheap model)
The text is split on paragraph boundaries into overlapping 14k-character chunks. Each chunk is scanned in parallel for character names, aliases, concrete description, and verbatim quotes. The overlap is what keeps a character introduced right at a chunk seam visible to both sides.

**Merge**
Names and aliases are indexed together, so different forms of address across chunks converge onto one person. Characters are ranked by how many chunks mention them — that ranking is the proxy for screen time.

**Pass 2 — profile**
Only the top N characters get a full sheet, built from every observation merged for them. Each one is told the names of its siblings in the same cast, so their looks and voices don't collapse into each other.

**Validate** (never skipped)
Four hard rules, all checked deterministically by a script rather than trusted to the model:

| Rule | Why |
| --- | --- |
| `evidence` must be a **verbatim, contiguous** span of the source | Stops invention. Dialogue split by a narration beat may not be stitched back together |
| Image prompts must **not contain character names** | Image models bias hard on names and will draw the character they remember instead of yours |
| **Language split** per field | Human-readable fields follow `--lang`, `image.prompt` is always English — the model drifts otherwise |
| Structure and enums | `importance` is one of exactly four values |

None of these were written up front. Each one exists because real model output violated it and the validator caught it.

## Use the scripts directly

The helpers run fine without an agent — only the two model passes need one:

```bash
node scripts/novel-characters.mjs chunk book.txt /tmp/wk        # split
node scripts/novel-characters.mjs merge /tmp/wk                 # merge roster-*.json
node scripts/novel-characters.mjs validate cast.json book.txt   # validate
node scripts/novel-characters.mjs render cast.json --html       # build report.html
node scripts/novel-characters.mjs slug "胡二爷"                  # filesystem-safe name
```

## Limits

- Caps at 24 chunks (~330k characters) per run. Beyond that it reports `truncated` explicitly — it does **not** silently drop the tail
- Human-readable fields follow `--lang`; image and TTS prompts are **always English**, since those engines work best that way regardless of report language
- Sheets are generated automatically only for `protagonist` and `major`; everyone else gets the prompts only
- **Art style drifts across a cast.** Each character is generated independently, and in practice the same `flat vector cartoon style` instruction produced anime-ish, semi-realistic, and ink-wash-realistic results in one run. Feeding the first sheet back as a style reference helps (see `references/sheet.md`) but does not fully fix it

> ⚠️ **If you have more than one codex installed, mind the version.** An older one fails outright with `requires a newer version of Codex` instead of degrading. The skill probes for the highest version it can find; if yours is simply old, run `npm i -g @openai/codex`.

## Files

```
SKILL.md                 the workflow the agent reads
scripts/
  novel-characters.mjs   chunk / merge / validate / render / slug
  selftest.mjs           129 assertions, never calls a model
references/
  roster-pass.md         pass 1: scanning for characters
  profile-pass.md        pass 2: building a character sheet (8 hard rules)
  schema.md              sheet structure and which language each field takes
  sheet.md               the codex contract for model-sheet generation
  report-style.md        design conventions for report.html
examples/
  渡口.txt                bundled short story, 4 characters
  渡口-cast.json          its output, doubling as the validation fixture
  渡口-cast.md            rendered result, a quality baseline
```

In `examples/渡口.txt` the peddler is only ever referred to by a nickname and the ferryman is addressed once as "old uncle" — the story exists specifically to exercise alias merging.

## Self-test

```bash
node scripts/selftest.mjs
```

129 assertions across chunking, alias merging, localization, validation, and rendering. No model calls, no quota, runs in about a second. Run it before anything else after touching the scripts.

**Only tested on macOS with Node 24.** There is no platform-specific code, so Linux and older Node releases should be fine, but that is **unverified** — the repository's CI (`ci/selftest.yml`) is not enabled yet.
