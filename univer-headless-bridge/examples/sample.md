# Univer Headless Bridge

A **deterministic** Markdown → PDF pipeline built on the *Univer* document engine.
Text is laid out by `@univerjs/engine-render` inside headless Chromium and printed
as a vector PDF.

## Why

1. Agents shouldn't have to load the whole monorepo into context.
2. Univer's renderer needs Canvas 2D + font metrics — only a browser has them.
3. One CLI, one skill file, stable error codes.

## Features

- Headings, paragraphs, **bold**, *italic*, ~~strike~~, `inline code`
- Ordered and unordered lists
  - Nested items work too
- Links such as [univer.ai](https://univer.ai)
- Task lists:
  - [x] Reconnaissance
  - [ ] Ship v1

> Blockquotes are rendered as an indented block with a left rule.

```ts
export function markdownToUniver(md: string): IDocumentData {
  return builder.build(); // tokens: \r paragraph, \n section
}
```

| Stage | Package | Runs in |
|:------|:--------|--------:|
| Parse | remark  | Node    |
| Snapshot | adapter | Node |
| Layout | engine-render | Chromium |

---

Final paragraph after a horizontal rule. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
