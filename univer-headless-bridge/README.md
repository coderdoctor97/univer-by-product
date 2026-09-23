# univer-headless-bridge

Agent-facing harness that turns Markdown (or a raw Univer `IDocumentData`
snapshot) into a **vector PDF** using the real Univer document layout engine
(`@univerjs/engine-render` v1.0.0) running inside headless Chromium.

```
[.md / .json] → src/adapter (remark → IDocumentData) → src/harness (Playwright)
             → dist/web/univer-runtime.js (Univer in Chromium, SVG paint) → page.pdf()
```

See `.agents/skills/univer-pdf/SKILL.md` for the operational contract (CLI
flags, error codes, JSON result). See `PRD.md` in the repo root for the design.

## Quick start

```bash
pnpm install
pnpm run build           # web bundle + node CLI
pnpm run example         # examples/sample.md → out/sample.pdf (+ snapshot json)
pnpm test                # adapter unit tests (no browser)
```

## Layout

| Path | Role |
|---|---|
| `src/adapter/markdown-to-univer.ts` | Deterministic mdast → `IDocumentData` (data-stream tokens, text runs, lists, tables, block ranges, hyperlinks) |
| `src/schema/render-request.ts` | Shared Node ⇄ browser contract |
| `src/browser/univer-page-runtime.ts` | Runs in Chromium: `DocumentDataModel → DocumentViewModel → DocumentSkeleton.calculate() → Documents.draw()` |
| `src/browser/svg-context.ts` | `canvas2svg` wrapper with the CTM tracking / clip / dash fixes Univer's `UniverRenderingContext` needs |
| `src/harness/browser-runtime.ts` | Launches Chromium, injects bundle, awaits fonts + layout, prints PDF |
| `src/cli.ts` | `univer-pdf` CLI (`--input`, `--output`, `--dump-snapshot`, `--json`, …) |
| `scripts/build-web.ts` | esbuild IIFE bundle of the browser runtime |
| `.agents/skills/univer-pdf/SKILL.md` | Skill file for AI agents |

## Upstream reconnaissance (Univer v1.0.0, commit `d592fb7`)

Schema: `packages/core/src/types/interfaces/i-document-data.ts` —
`IDocumentData` (L29), `IDocumentBody` (L196), `ITextRun` (L452),
`IParagraph` (L891), `IParagraphStyle` (L1180), `ITable` (L1478).
Tokens: `packages/core/src/docs/data-model/types.ts`.
Minimal snapshot: `packages/core/src/docs/data-model/empty-snapshot.ts`
(`dataStream: '\r\n'`, A4 = 794×1124 px @96dpi, margins 72,
`DocumentFlavor.TRADITIONAL` for paginated pages).
Preset lists: `packages/core/src/docs/data-model/preset-list-type.ts`.

Render path: `packages/engine-render/src/components/docs/layout/doc-skeleton.ts`
(`DocumentSkeleton.create`, `calculate()`, `getSkeletonData().pages`),
`components/docs/document.ts` (`Documents.draw`), and the reference wiring in
`packages/docs-ui/src/controllers/render-controllers/doc.render-controller.ts`.
Test bed pattern reused here: `engine-render/src/components/docs/__tests__/document.spec.ts`.

DOM dependencies confirmed (hence the browser): `document.createElement('canvas'|'span'|'div')`
for glyph metrics (`shaping-engine/font-cache.ts`), `ResizeObserver` / `matchMedia` /
`devicePixelRatio` (`engine.ts`), `requestAnimationFrame` (`basics/tools.ts`),
`document.fonts`. The published UMD/ESM bundles of `@univerjs/core` and
`@univerjs/engine-render` are what we bundle (peer: `rxjs`).

## Chromium

Playwright's CDN may be unreachable in locked-down sandboxes. The harness falls
back to `@sparticuz/chromium` (npm-distributed binary) and wires its bundled
NSS libs / fontconfig via `LD_LIBRARY_PATH` / `FONTCONFIG_PATH`. Override with
`UNIVER_BRIDGE_CHROMIUM=/path/to/chrome` or `--chromium`.

## Known limits (v0.1)

* Mixed page sizes across sections print with the first page's size.
* Images are placeholders; footnotes are inline `[^n]` text.
* Headers/footers are not generated from Markdown (snapshots that define them render fine).
