---
name: univer-pdf
description: Convert Markdown (or a Univer IDocumentData JSON snapshot) into a vector PDF using Univer's document layout engine in headless Chromium. Use when a task needs a paginated PDF from Markdown, or when you need Univer's document snapshot for a piece of text.
---

# univer-pdf

Deterministic Markdown → Univer `IDocumentData` → vector PDF.
Everything runs locally: Node builds the snapshot, headless Chromium runs
`@univerjs/engine-render`, and CDP prints the pages. **Never import
`@univerjs/engine-render` in Node** — it needs Canvas 2D + DOM font metrics.

## Setup (once per checkout)

```bash
cd univer-headless-bridge
pnpm install            # also installs the @sparticuz/chromium fallback
pnpm run build          # dist/web/univer-runtime.js (browser) + dist/cli.js (node)
pnpm run browser:install   # optional: Playwright-managed Chromium (needs CDN access)
```

Chromium resolution order: `--chromium <path>` → `$UNIVER_BRIDGE_CHROMIUM` →
Playwright-managed → `@sparticuz/chromium` (npm-distributed binary).

## Commands

```bash
# Markdown -> PDF
node dist/cli.js --input doc.md --output out/doc.pdf

# Also keep the intermediate snapshot (out/doc.snapshot.json)
node dist/cli.js -i doc.md -o out/doc.pdf --dump-snapshot

# Snapshot only, to stdout (no browser is launched)
node dist/cli.js -i doc.md --dump-snapshot

# Render a hand-built / edited snapshot
node dist/cli.js -i doc.snapshot.json -o out/doc.pdf

# Machine-readable result (last stdout line is JSON)
node dist/cli.js -i doc.md -o out/doc.pdf --json
```

Useful flags: `--paper A4|Letter|Legal|A3|A5` · `--margin <px>` (96-dpi px, 72 default)
· `--font <family>` · `--code-font <family>` · `--font-size <pt>` · `--mode svg|canvas`
(svg = selectable vector text, default) · `--timeout <ms>` · `-v` progress on stderr
· `--debug` writes `<output>.debug.html` and echoes browser console.

## Result contract

Success (`--json`):
```json
{"ok":true,"output":"/abs/out/doc.pdf","bytes":34677,"pages":2,
 "pageSize":{"width":794,"height":1124},"mode":"svg","layoutMs":78,"paintMs":53,
 "totalMs":1500,"missingFonts":[],"univerVersion":"1.0.0","browserVersion":"..."}
```
Failure (`--json`, exit code 2 or 3):
```json
{"ok":false,"code":"LAYOUT_FAILED","message":"...","detail":"stack / browser console"}
```

| code | exit | meaning / fix |
|---|---|---|
| `INVALID_SNAPSHOT` | 2 | JSON input is not an `IDocumentData`, or dataStream/paragraph invariants broken |
| `BUNDLE_MISSING` | 3 | run `pnpm run build:web` |
| `BROWSER_LAUNCH_FAILED` | 3 | no Chromium; see resolution order above |
| `RUNTIME_NOT_READY` | 3 | web bundle failed to evaluate (check `--debug`) |
| `LAYOUT_FAILED` / `PAINT_FAILED` | 3 | Univer threw; `--debug -v` prints the stack |
| `RENDER_TIMEOUT` | 3 | raise `--timeout` |

`missingFonts` lists families the browser could not confirm; text still renders
with the fallback chain (DejaVu Sans is bundled for symbols/bullets).

## Supported Markdown

Headings h1–h6, paragraphs, **bold**, *italic*, ~~strike~~, `code`, links
(blue + underline), ordered/unordered/nested lists, task lists, blockquotes,
fenced code blocks, GFM tables (alignment, header row repeats across pages),
horizontal rules. Images are rendered as `[image: alt]` placeholders. Raw HTML is
emitted as monospace text.

## Snapshot cheat-sheet (when editing JSON directly)

* `body.dataStream` is a flat string: `\r` ends a paragraph, `\n` ends a section;
  the stream **must end with `\r\n`**.
* `body.paragraphs[i].startIndex` must point at a `\r`; `sectionBreaks[i].startIndex` at a `\n`.
* `body.textRuns` are `[st, ed)` ranges with `ts: { ff, fs(pt), bl, it, cl:{rgb}, bg:{rgb}, ul:{s:1}, st:{s:1} }`.
* Page geometry is in 96-dpi px: `documentStyle.pageSize` A4 = `{794,1124}`, margins `72`.
* Lists: `paragraph.bullet = { listType: 'BULLET_LIST'|'ORDER_LIST', listId, nestingLevel }`.
* Tables use control tokens `\x1A…\x0F` plus `body.tables[]` + `tableSource{}`; generate them via Markdown rather than by hand.

Validate a snapshot without a browser: `node dist/cli.js -i x.json --dump-snapshot /dev/null`.

## Programmatic use

```ts
import { markdownToUniver } from './src/adapter/markdown-to-univer.js';
import { renderSnapshotToPdf } from './src/harness/browser-runtime.js';
const snapshot = markdownToUniver(md, { paper: 'Letter' });
const result = await renderSnapshotToPdf(snapshot, { outputPath: 'out/doc.pdf' });
```
