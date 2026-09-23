/**
 * Markdown -> Univer `IDocumentData` adapter.
 *
 * Deterministic translation of a remark (mdast) tree into Univer's document
 * snapshot. Everything here targets the schema in
 * `@univerjs/core/src/types/interfaces/i-document-data.ts` (v1.0.0):
 *
 *   - body.dataStream : flat UTF-16 string with control tokens
 *       '\r'   paragraph end            (DataStreamTreeTokenType.PARAGRAPH)
 *       '\n'   section break            (DataStreamTreeTokenType.SECTION_BREAK)
 *       '\x1A' table start   '\x1B' row start   '\x1C' cell start
 *       '\x1D' cell end      '\x0E' row end     '\x0F' table end
 *       '\x10' block start   '\x11' block end   (quote / code / callout ranges)
 *   - body.textRuns   : [st, ed) half-open styled ranges
 *   - body.paragraphs : one entry per '\r', startIndex = index of the '\r'
 *   - body.sectionBreaks : one entry per '\n'
 *   - body.tables + tableSource : ICustomTable ranges + ITable definitions
 *   - body.blockRanges : quote / code containers
 *   - body.customRanges : hyperlinks (CustomRangeType.HYPERLINK)
 *
 * Every id is derived from a running counter so the output is byte-stable for
 * the same input (no random ids, no timestamps).
 */

import type {
    IBullet,
    ICustomRange,
    ICustomTable,
    IDocumentBlockRange,
    IDocumentBody,
    IDocumentData,
    IParagraph,
    IParagraphStyle,
    ISectionBreak,
    ITable,
    ITableCell,
    ITableColumn,
    ITableRow,
    ITextRun,
    ITextStyle,
} from '@univerjs/core';
import type {
    Blockquote,
    Code,
    Content,
    Heading,
    List,
    ListItem,
    Paragraph,
    PhrasingContent,
    Root,
    Table,
    ThematicBreak,
} from 'mdast';
import {
    BooleanNumber,
    BulletAlignment,
    CustomRangeType,
    DashStyleType,
    DocumentBlockRangeType,
    DocumentFlavor,
    HorizontalAlign,
    ListGlyphType,
    LocaleType,
    NamedStyleType,
    ObjectRelativeFromH,
    ObjectRelativeFromV,
    PresetListType,
    TableAlignmentType,
    TableRowHeightRule,
    TableSizeType,
    TableTextWrapType,
    TextDecoration,
} from '@univerjs/core';
import { toString as mdastToString } from 'mdast-util-to-string';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

// ---------------------------------------------------------------------------
// Data-stream tokens (mirrors DataStreamTreeTokenType in @univerjs/core)
// ---------------------------------------------------------------------------
const TOKEN = {
    PARAGRAPH: '\r',
    SECTION_BREAK: '\n',
    TABLE_START: '\x1A',
    TABLE_ROW_START: '\x1B',
    TABLE_CELL_START: '\x1C',
    TABLE_CELL_END: '\x1D',
    TABLE_ROW_END: '\x0E',
    TABLE_END: '\x0F',
    BLOCK_START: '\x10',
    BLOCK_END: '\x11',
    TAB: '\t',
} as const;

// ---------------------------------------------------------------------------
// Options / page presets (units: 96-DPI layout px, see PAGE_SIZE in core)
// ---------------------------------------------------------------------------
export type PaperPreset = 'A4' | 'Letter' | 'Legal' | 'A3' | 'A5';

const PAGE_SIZE: Record<PaperPreset, { width: number; height: number }> = {
    A3: { width: 1123, height: 1587 },
    A4: { width: 794, height: 1124 },
    A5: { width: 559, height: 794 },
    Legal: { width: 816, height: 1344 },
    Letter: { width: 816, height: 1056 },
};

export interface IMarkdownToUniverOptions {
    /** Unit id written to `IDocumentData.id`. Default: 'univer-headless-doc'. */
    id?: string;
    title?: string;
    paper?: PaperPreset;
    /** Page margin in layout px (all four sides). Default 72 (= 0.75in, Univer TRADITIONAL default). */
    margin?: number;
    /** Base body font. Default 'Arial' (Univer DEFAULT_STYLES.ff). */
    fontFamily?: string;
    /** Monospace family used for inline/blocks code. */
    codeFontFamily?: string;
    /** Base font size in pt. Default 11 (Univer DEFAULT_STYLES.fs). */
    fontSize?: number;
    locale?: LocaleType;
}

interface IResolvedOptions extends Required<Omit<IMarkdownToUniverOptions, 'title'>> {
    title: string | undefined;
}

const HEADING_STYLES: Record<number, { fs: number; namedStyleType: NamedStyleType; spaceAbove: number; spaceBelow: number }> = {
    1: { fs: 24, namedStyleType: NamedStyleType.HEADING_1, spaceAbove: 20, spaceBelow: 8 },
    2: { fs: 18, namedStyleType: NamedStyleType.HEADING_2, spaceAbove: 16, spaceBelow: 6 },
    3: { fs: 14.5, namedStyleType: NamedStyleType.HEADING_3, spaceAbove: 14, spaceBelow: 4 },
    4: { fs: 12.5, namedStyleType: NamedStyleType.HEADING_4, spaceAbove: 12, spaceBelow: 4 },
    5: { fs: 11.5, namedStyleType: NamedStyleType.HEADING_5, spaceAbove: 10, spaceBelow: 2 },
    6: { fs: 11, namedStyleType: NamedStyleType.HEADING_5, spaceAbove: 10, spaceBelow: 2 },
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------
interface IInlineStyle {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    strike?: boolean;
    link?: string;
}

class SnapshotBuilder {
    private stream = '';
    private readonly textRuns: ITextRun[] = [];
    private readonly paragraphs: IParagraph[] = [];
    private readonly sectionBreaks: ISectionBreak[] = [];
    private readonly tables: ICustomTable[] = [];
    private readonly blockRanges: IDocumentBlockRange[] = [];
    private readonly customRanges: ICustomRange[] = [];
    private readonly tableSource: Record<string, ITable> = {};
    private counter = 0;

    constructor(private readonly opts: IResolvedOptions) {}

    get length(): number {
        return this.stream.length;
    }

    private nextId(prefix: string): string {
        this.counter += 1;
        return `${prefix}-${this.counter}`;
    }

    private baseTextStyle(style: IInlineStyle): ITextStyle {
        const ts: ITextStyle = {
            ff: style.code ? this.opts.codeFontFamily : this.opts.fontFamily,
            fs: style.code ? Math.max(this.opts.fontSize - 1, 8) : this.opts.fontSize,
        };
        if (style.bold) ts.bl = BooleanNumber.TRUE;
        if (style.italic) ts.it = BooleanNumber.TRUE;
        if (style.strike) ts.st = { s: BooleanNumber.TRUE };
        if (style.code) ts.bg = { rgb: '#f1f5f9' };
        if (style.link) {
            ts.cl = { rgb: '#1d4ed8' };
            ts.ul = { s: BooleanNumber.TRUE };
        }
        return ts;
    }

    /** Append raw text with a style, merging adjacent identical runs. */
    text(value: string, style: IInlineStyle, override?: Partial<ITextStyle>): void {
        if (value.length === 0) return;
        const ts: ITextStyle = { ...this.baseTextStyle(style), ...override };
        const st = this.stream.length;
        this.stream += value;
        const ed = this.stream.length;
        const last = this.textRuns[this.textRuns.length - 1];
        if (last && last.ed === st && JSON.stringify(last.ts) === JSON.stringify(ts)) {
            last.ed = ed;
        } else {
            this.textRuns.push({ st, ed, ts });
        }
    }

    hyperlink(url: string, startIndex: number, endIndex: number): void {
        if (endIndex <= startIndex) return;
        this.customRanges.push({
            startIndex,
            endIndex: endIndex - 1, // inclusive end
            rangeId: this.nextId('link'),
            rangeType: CustomRangeType.HYPERLINK,
            properties: { url },
        });
    }

    /** Terminate the current paragraph with '\r'. */
    endParagraph(paragraphStyle: IParagraphStyle = {}, bullet?: IBullet): void {
        const startIndex = this.stream.length;
        this.stream += TOKEN.PARAGRAPH;
        // Paragraph mark itself carries the body style so an empty paragraph
        // still has a measurable line height.
        this.textRuns.push({
            st: startIndex,
            ed: startIndex + 1,
            ts: this.baseTextStyle({}),
        });
        const paragraph: IParagraph = {
            startIndex,
            paragraphId: this.nextId('p'),
            paragraphStyle,
        };
        if (bullet) paragraph.bullet = bullet;
        this.paragraphs.push(paragraph);
    }

    endSection(): void {
        const startIndex = this.stream.length;
        this.stream += TOKEN.SECTION_BREAK;
        this.sectionBreaks.push({ sectionId: this.nextId('s'), startIndex });
    }

    openBlock(): number {
        const startIndex = this.stream.length;
        this.stream += TOKEN.BLOCK_START;
        return startIndex;
    }

    closeBlock(startIndex: number, blockType: DocumentBlockRangeType): void {
        const endIndex = this.stream.length;
        this.stream += TOKEN.BLOCK_END;
        this.blockRanges.push({ startIndex, endIndex, blockId: this.nextId('blk'), blockType });
    }

    // ---- tables -----------------------------------------------------------
    table(rows: string[][][], align: (HorizontalAlign | undefined)[], renderCell: (cell: string[], isHeader: boolean) => void): void {
        // rows: [rowIndex][cellIndex] -> segments (already rendered by caller via renderCell)
        const colCount = Math.max(1, ...rows.map((r) => r.length));
        const contentWidth = this.contentWidth();
        const colWidth = Math.floor(contentWidth / colCount);
        const tableId = this.nextId('tbl');

        const startIndex = this.stream.length;
        this.stream += TOKEN.TABLE_START;

        const tableRows: ITableRow[] = [];
        rows.forEach((row, rowIndex) => {
            this.stream += TOKEN.TABLE_ROW_START;
            const cells: ITableCell[] = [];
            for (let c = 0; c < colCount; c++) {
                this.stream += TOKEN.TABLE_CELL_START;
                const cellContent = row[c] ?? [];
                const isHeader = rowIndex === 0;
                renderCell(cellContent, isHeader);
                this.endParagraph({
                    horizontalAlign: align[c] ?? HorizontalAlign.LEFT,
                    spaceAbove: { v: 2 },
                    spaceBelow: { v: 2 },
                    lineSpacing: 1.15,
                });
                this.endSection();
                this.stream += TOKEN.TABLE_CELL_END;
                const cell: ITableCell = {
                    margin: { start: { v: 6 }, end: { v: 6 }, top: { v: 4 }, bottom: { v: 4 } },
                    borderTop: border(),
                    borderBottom: border(),
                    borderLeft: border(),
                    borderRight: border(),
                };
                if (isHeader) cell.backgroundColor = { rgb: '#f1f5f9' };
                cells.push(cell);
            }
            this.stream += TOKEN.TABLE_ROW_END;
            const tr: ITableRow = {
                tableCells: cells,
                trHeight: { val: { v: 24 }, hRule: TableRowHeightRule.AUTO },
                cantSplit: BooleanNumber.TRUE,
            };
            if (rowIndex === 0) {
                tr.isFirstRow = BooleanNumber.TRUE;
                tr.repeatHeaderRow = BooleanNumber.TRUE;
            }
            tableRows.push(tr);
        });

        this.stream += TOKEN.TABLE_END;
        const endIndex = this.stream.length - 1;
        this.tables.push({ startIndex, endIndex, tableId });

        const tableColumns: ITableColumn[] = Array.from({ length: colCount }, () => ({
            size: { type: TableSizeType.SPECIFIED, width: { v: colWidth } },
        }));

        this.tableSource[tableId] = {
            tableId,
            tableRows,
            tableColumns,
            align: TableAlignmentType.START,
            indent: { v: 0 },
            textWrap: TableTextWrapType.NONE,
            position: {
                positionH: { relativeFrom: ObjectRelativeFromH.PAGE, posOffset: 0 },
                positionV: { relativeFrom: ObjectRelativeFromV.PAGE, posOffset: 0 },
            },
            dist: { distB: 0, distL: 0, distR: 0, distT: 0 },
            size: { type: TableSizeType.SPECIFIED, width: { v: colWidth * colCount } },
            cellMargin: { start: { v: 6 }, end: { v: 6 }, top: { v: 4 }, bottom: { v: 4 } },
        };

        // A table must be followed by a paragraph so the flow can continue.
        this.endParagraph({ spaceAbove: { v: 0 }, spaceBelow: { v: 6 } });
    }

    contentWidth(): number {
        const size = PAGE_SIZE[this.opts.paper];
        return size.width - this.opts.margin * 2;
    }

    build(): IDocumentData {
        // Final section break closes the body: dataStream must end with '\r\n'.
        if (!this.stream.endsWith(TOKEN.PARAGRAPH)) {
            this.endParagraph();
        }
        this.endSection();

        const body: IDocumentBody = {
            dataStream: this.stream,
            textRuns: this.textRuns,
            paragraphs: this.paragraphs,
            sectionBreaks: this.sectionBreaks,
            customBlocks: [],
            tables: this.tables,
            blockRanges: this.blockRanges,
            customRanges: this.customRanges,
            customDecorations: [],
        };

        const size = PAGE_SIZE[this.opts.paper];
        const doc: IDocumentData = {
            id: this.opts.id,
            locale: this.opts.locale,
            title: this.opts.title ?? '',
            body,
            tableSource: this.tableSource,
            drawings: {},
            drawingsOrder: [],
            headers: {},
            footers: {},
            documentStyle: {
                pageSize: { width: size.width, height: size.height },
                documentFlavor: DocumentFlavor.TRADITIONAL,
                marginTop: this.opts.margin,
                marginBottom: this.opts.margin,
                marginLeft: this.opts.margin,
                marginRight: this.opts.margin,
                marginHeader: 30,
                marginFooter: 30,
                autoHyphenation: BooleanNumber.FALSE,
                defaultHeaderId: '',
                defaultFooterId: '',
                evenPageHeaderId: '',
                evenPageFooterId: '',
                firstPageHeaderId: '',
                firstPageFooterId: '',
                evenAndOddHeaders: BooleanNumber.FALSE,
                useFirstPageHeaderFooter: BooleanNumber.FALSE,
                textStyle: { ff: this.opts.fontFamily, fs: this.opts.fontSize },
                defaultParagraphStyle: {
                    spaceAbove: { v: 0 },
                    spaceBelow: { v: 8 },
                    lineSpacing: 1.3,
                },
                renderConfig: {
                    vertexAngle: 0,
                    centerAngle: 0,
                },
            },
            settings: { zoomRatio: 1 },
        };
        return doc;
    }
}

function border() {
    return { color: { rgb: '#cbd5e1' }, width: { v: 1 }, dashStyle: DashStyleType.SOLID };
}

// ---------------------------------------------------------------------------
// mdast walker
// ---------------------------------------------------------------------------
class MarkdownEmitter {
    private listCounter = 0;

    constructor(private readonly b: SnapshotBuilder, private readonly opts: IResolvedOptions) {}

    root(root: Root): void {
        this.blocks(root.children, {});
    }

    private blocks(nodes: Content[], ctx: { bullet?: IBullet; indent?: number; inQuote?: boolean }): void {
        for (const node of nodes) {
            this.block(node, ctx);
        }
    }

    private paragraphStyle(extra: IParagraphStyle, ctx: { indent?: number }): IParagraphStyle {
        const style: IParagraphStyle = { ...extra };
        if (ctx.indent) style.indentStart = { v: ctx.indent };
        return style;
    }

    private block(node: Content, ctx: { bullet?: IBullet; indent?: number; inQuote?: boolean }): void {
        switch (node.type) {
            case 'heading':
                return this.heading(node, ctx);
            case 'paragraph':
                return this.paragraph(node, ctx);
            case 'list':
                return this.list(node, ctx);
            case 'blockquote':
                return this.blockquote(node, ctx);
            case 'code':
                return this.code(node, ctx);
            case 'thematicBreak':
                return this.thematicBreak(node, ctx);
            case 'table':
                return this.table(node);
            case 'html':
                // Raw HTML is not rendered; emit it as monospace text so nothing is silently lost.
                this.b.text(node.value, { code: true });
                this.b.endParagraph(this.paragraphStyle({}, ctx));
                return;
            case 'listItem':
                return this.listItem(node, ctx, undefined);
            default:
                // Unknown block: fall back to plain text.
                this.b.text(mdastToString(node), {});
                this.b.endParagraph(this.paragraphStyle({}, ctx));
        }
    }

    private heading(node: Heading, ctx: { indent?: number }): void {
        const spec = HEADING_STYLES[node.depth] ?? HEADING_STYLES[6]!;
        this.inline(node.children, { bold: true }, { fs: spec.fs, cl: { rgb: '#0f172a' } });
        const style = this.paragraphStyle({
            namedStyleType: spec.namedStyleType,
            headingId: `h-${this.b.length}`,
            spaceAbove: { v: spec.spaceAbove },
            spaceBelow: { v: spec.spaceBelow },
            lineSpacing: 1.2,
            keepNext: BooleanNumber.TRUE,
        }, ctx);
        this.b.endParagraph(style);
    }

    private paragraph(node: Paragraph, ctx: { bullet?: IBullet; indent?: number }): void {
        this.inline(node.children, {});
        const style = this.paragraphStyle({}, ctx);
        this.b.endParagraph(style, ctx.bullet);
    }

    private list(node: List, ctx: { indent?: number; inQuote?: boolean }, nesting = 0): void {
        this.listCounter += 1;
        const listId = `list-${this.listCounter}`;
        const listType = node.ordered ? PresetListType.ORDER_LIST : PresetListType.BULLET_LIST;
        node.children.forEach((item, index) => {
            const bullet: IBullet = {
                listType,
                listId,
                nestingLevel: nesting,
            };
            if (node.ordered && index === 0 && node.start != null && node.start !== 1) {
                bullet.startNumber = node.start - 1;
            }
            this.listItem(item, ctx, bullet, nesting);
        });
    }

    private listItem(item: ListItem, ctx: { indent?: number; inQuote?: boolean }, bullet: IBullet | undefined, nesting = 0): void {
        let first = true;
        for (const child of item.children) {
            if (child.type === 'list') {
                this.list(child, ctx, nesting + 1);
                continue;
            }
            if (child.type === 'paragraph') {
                if (item.checked != null) {
                    this.b.text(item.checked ? '\u2611 ' : '\u2610 ', {});
                }
                this.inline(child.children, {});
                if (first) {
                    this.b.endParagraph(this.paragraphStyle({ spaceBelow: { v: 3 }, spaceAbove: { v: 0 } }, ctx), bullet);
                } else {
                    // Continuation paragraph of the same item: no marker, indented under the text.
                    this.b.endParagraph(this.paragraphStyle({ spaceBelow: { v: 3 }, spaceAbove: { v: 0 } }, {
                        indent: (ctx.indent ?? 0) + 24 * (nesting + 1),
                    }));
                }
                first = false;
                continue;
            }
            // Other blocks inside a list item get the same indent as the item text.
            this.block(child, { indent: (ctx.indent ?? 0) + 24 * (nesting + 1) });
            first = false;
        }
        if (first) {
            // Empty list item
            this.b.endParagraph(this.paragraphStyle({}, ctx), bullet);
        }
    }

    private blockquote(node: Blockquote, ctx: { indent?: number }): void {
        const start = this.b.openBlock();
        const quoteCtx = { indent: (ctx.indent ?? 0), inQuote: true };
        for (const child of node.children) {
            if (child.type === 'paragraph') {
                this.inline(child.children, { italic: true }, { cl: { rgb: '#475569' } });
                this.b.endParagraph(this.paragraphStyle({
                    indentStart: { v: 16 + (ctx.indent ?? 0) },
                    spaceBelow: { v: 4 },
                    borderLeft: { color: { rgb: '#94a3b8' }, width: 3, dashStyle: DashStyleType.SOLID, padding: 10 },
                }, {}));
            } else {
                this.block(child, quoteCtx);
            }
        }
        this.b.closeBlock(start, DocumentBlockRangeType.QUOTE);
    }

    private code(node: Code, ctx: { indent?: number }): void {
        const start = this.b.openBlock();
        const lines = node.value.replace(/\r\n?/g, '\n').split('\n');
        for (const line of lines) {
            // Preserve leading whitespace; a tab stays a tab token.
            this.b.text(line.length ? line : ' ', { code: true }, { bg: null });
            this.b.endParagraph(this.paragraphStyle({
                spaceAbove: { v: 0 },
                spaceBelow: { v: 0 },
                lineSpacing: 1.25,
                indentStart: { v: 10 + (ctx.indent ?? 0) },
                indentEnd: { v: 10 },
                shading: { backgroundColor: { rgb: '#f1f5f9' } },
                keepLines: BooleanNumber.TRUE,
            }, {}));
        }
        this.b.closeBlock(start, DocumentBlockRangeType.CODE);
        // Breathing room after a code block.
        this.b.endParagraph({ spaceAbove: { v: 0 }, spaceBelow: { v: 4 }, lineSpacing: 0.6 });
    }

    private thematicBreak(_node: ThematicBreak, ctx: { indent?: number }): void {
        this.b.endParagraph(this.paragraphStyle({
            spaceAbove: { v: 6 },
            spaceBelow: { v: 6 },
            lineSpacing: 0.5,
            borderBottom: { color: { rgb: '#cbd5e1' }, width: 1, dashStyle: DashStyleType.SOLID, padding: 2 },
        }, ctx));
    }

    private table(node: Table): void {
        const align = (node.align ?? []).map((a) => {
            switch (a) {
                case 'center': return HorizontalAlign.CENTER;
                case 'right': return HorizontalAlign.RIGHT;
                case 'left': return HorizontalAlign.LEFT;
                default: return undefined;
            }
        });
        const rows = node.children.map((row) => row.children.map((cell) => cell.children));
        this.b.table(
            rows as unknown as string[][][],
            align,
            (cell, isHeader) => this.inline(cell as unknown as PhrasingContent[], { bold: isHeader })
        );
    }

    // ---- inline -----------------------------------------------------------
    private inline(nodes: PhrasingContent[], style: IInlineStyle, override?: Partial<ITextStyle>): void {
        for (const node of nodes) {
            switch (node.type) {
                case 'text':
                    this.b.text(normalizeWhitespace(node.value), style, override);
                    break;
                case 'strong':
                    this.inline(node.children, { ...style, bold: true }, override);
                    break;
                case 'emphasis':
                    this.inline(node.children, { ...style, italic: true }, override);
                    break;
                case 'delete':
                    this.inline(node.children, { ...style, strike: true }, override);
                    break;
                case 'inlineCode':
                    this.b.text(node.value, { ...style, code: true }, override);
                    break;
                case 'break':
                    // Soft line break inside a paragraph: Univer has no dedicated
                    // token, emit a space (a '\r' would start a new paragraph).
                    this.b.text(' ', style, override);
                    break;
                case 'link': {
                    const start = this.b.length;
                    this.inline(node.children, { ...style, link: node.url }, override);
                    this.b.hyperlink(node.url, start, this.b.length);
                    break;
                }
                case 'image':
                    this.b.text(`[image: ${node.alt ?? node.url}]`, { ...style, italic: true }, { cl: { rgb: '#64748b' } });
                    break;
                case 'html':
                    this.b.text(node.value, { ...style, code: true }, override);
                    break;
                case 'footnoteReference':
                    this.b.text(`[^${node.identifier}]`, style, override);
                    break;
                default:
                    this.b.text(mdastToString(node), style, override);
            }
        }
    }
}

function normalizeWhitespace(value: string): string {
    // Markdown soft line breaks inside a paragraph collapse to a single space.
    return value.replace(/[ \t]*\n[ \t]*/g, ' ');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function parseMarkdown(markdown: string): Root {
    return unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
}

export function markdownToUniver(markdown: string, options: IMarkdownToUniverOptions = {}): IDocumentData {
    const opts: IResolvedOptions = {
        id: options.id ?? 'univer-headless-doc',
        title: options.title,
        paper: options.paper ?? 'A4',
        margin: options.margin ?? 72,
        fontFamily: options.fontFamily ?? 'Arial',
        codeFontFamily: options.codeFontFamily ?? 'Courier New',
        fontSize: options.fontSize ?? 11,
        locale: options.locale ?? LocaleType.EN_US,
    };
    const builder = new SnapshotBuilder(opts);
    const emitter = new MarkdownEmitter(builder, opts);
    emitter.root(parseMarkdown(markdown));
    return builder.build();
}

/**
 * Lightweight structural validation that mirrors the invariants Univer's
 * `DocumentViewModel` / structure-validator rely on. Throws on violation.
 */
export function assertSnapshotInvariants(doc: IDocumentData): void {
    const body = doc.body;
    if (!body) throw new Error('snapshot.body is required');
    const { dataStream, paragraphs = [], sectionBreaks = [], textRuns = [] } = body;
    if (!dataStream.endsWith('\r\n')) throw new Error('dataStream must end with "\\r\\n"');
    for (const p of paragraphs) {
        if (dataStream[p.startIndex] !== '\r') throw new Error(`paragraph ${p.paragraphId} does not point at "\\r" (index ${p.startIndex})`);
    }
    for (const s of sectionBreaks) {
        if (dataStream[s.startIndex] !== '\n') throw new Error(`sectionBreak ${s.sectionId} does not point at "\\n" (index ${s.startIndex})`);
    }
    let prev = -1;
    for (const r of textRuns) {
        if (r.st >= r.ed) throw new Error(`textRun [${r.st},${r.ed}) is empty`);
        if (r.st < prev) throw new Error(`textRuns are not sorted at ${r.st}`);
        if (r.ed > dataStream.length) throw new Error(`textRun [${r.st},${r.ed}) exceeds dataStream length ${dataStream.length}`);
        prev = r.ed;
    }
    for (const t of body.tables ?? []) {
        if (dataStream[t.startIndex] !== '\x1A' || dataStream[t.endIndex] !== '\x0F') throw new Error(`table ${t.tableId} range is not bracketed by table tokens`);
        if (!doc.tableSource?.[t.tableId]) throw new Error(`table ${t.tableId} missing from tableSource`);
    }
    for (const b of body.blockRanges ?? []) {
        if (dataStream[b.startIndex] !== '\x10' || dataStream[b.endIndex] !== '\x11') throw new Error(`blockRange ${b.blockId} is not bracketed by block tokens`);
    }
}

export { BulletAlignment, ListGlyphType, TextDecoration };
