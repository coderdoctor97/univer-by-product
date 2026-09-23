/**
 * Browser-side Univer runtime.
 *
 * Bundled by `scripts/build-web.ts` (esbuild, IIFE) and injected into a blank
 * Chromium page by the Node harness. Exposes
 * `window.__univerHeadlessRender(request)`.
 *
 * Pipeline (mirrors what DocRenderController does in @univerjs/docs-ui, minus
 * the interactive scene / viewport / React UI):
 *
 *   IDocumentData
 *     -> new DocumentDataModel(snapshot)                 (@univerjs/core)
 *     -> new DocumentViewModel(dataModel)                (@univerjs/engine-render)
 *     -> DocumentSkeleton.create(viewModel, localeService)
 *     -> skeleton.calculate()                            (synchronous full layout)
 *     -> new Documents(key, skeleton, { pageMarginLeft: 0, pageMarginTop: 0 })
 *     -> per page: documents.draw(new UniverRenderingContext(ctx2d))
 *
 * For vector output each page is painted into a `canvas2svg` context (a
 * CanvasRenderingContext2D-compatible recorder that emits SVG). The resulting
 * SVGs are placed into the DOM as fixed-size CSS pages so the harness can call
 * `page.pdf()` and get real vector text.
 */

import type { IDocumentData } from '@univerjs/core';
import type { IDocumentSkeletonPage } from '@univerjs/engine-render';
import type { IPageMetrics, IRenderRequest, RenderOutcome } from '../schema/render-request.js';
import { DocumentDataModel, LocaleService, LocaleType, ThemeService, Univer } from '@univerjs/core';
import { CanvasColorService, DocumentSkeleton, Documents, DocumentViewModel, PageLayoutType, UniverRenderingContext } from '@univerjs/engine-render';
import { BROWSER_ENTRY_GLOBAL, BROWSER_READY_GLOBAL } from '../schema/render-request.js';
import { createSvgContext } from './svg-context.js';

declare const __UNIVER_VERSION__: string;

interface IPaintedPage {
    metrics: IPageMetrics;
    element: HTMLElement;
}

function fail(code: Extract<RenderOutcome, { ok: false }>['code'], error: unknown): RenderOutcome {
    const err = error instanceof Error ? error : new Error(String(error));
    return { ok: false, code, message: err.message, stack: err.stack };
}

async function awaitFonts(families: string[], timeoutMs: number): Promise<string[]> {
    const missing: string[] = [];
    if (!('fonts' in document)) return families;
    const deadline = Date.now() + timeoutMs;
    for (const family of families) {
        const spec = `12px "${family}"`;
        try {
            await Promise.race([
                document.fonts.load(spec),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), Math.max(0, deadline - Date.now()))),
            ]);
        } catch {
            // fall through to the check below
        }
        if (!document.fonts.check(spec)) missing.push(family);
    }
    await document.fonts.ready;
    return missing;
}

function pageMetrics(page: IDocumentSkeletonPage, index: number): IPageMetrics {
    return {
        index,
        width: page.pageWidth,
        height: page.pageHeight,
        marginTop: page.marginTop,
        marginLeft: page.marginLeft,
    };
}

/**
 * Paint page `index` only. `Documents.draw` walks every page and advances an
 * internal "liquid" cursor vertically; we translate the context so the
 * requested page lands at (0,0) and clip the rest.
 */
function paintPage(
    documents: Documents,
    pages: IDocumentSkeletonPage[],
    index: number,
    ctx2d: CanvasRenderingContext2D,
    canvasColorService: CanvasColorService
): void {
    let offsetY = 0;
    for (let i = 0; i < index; i++) {
        const p = pages[i]!;
        offsetY += p.pageHeight + documents.pageMarginTop;
    }
    const page = pages[index]!;
    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.rect(0, 0, page.pageWidth, page.pageHeight);
    ctx2d.clip();
    ctx2d.translate(0, -offsetY);
    // CanvasColorService resolves theme tokens such as 'blue.600' (hyperlinks) to real colours.
    const univerCtx = new UniverRenderingContext(ctx2d, { canvasColorService });
    documents.draw(univerCtx);
    ctx2d.restore();
}

function mountPage(element: HTMLElement, metrics: IPageMetrics): void {
    const wrapper = document.createElement('section');
    wrapper.className = 'univer-page';
    wrapper.style.width = `${metrics.width}px`;
    wrapper.style.height = `${metrics.height}px`;
    wrapper.dataset.pageIndex = String(metrics.index);
    wrapper.appendChild(element);
    document.getElementById('pages')!.appendChild(wrapper);
}

async function render(request: IRenderRequest): Promise<RenderOutcome> {
    const { snapshot, mode, dpr, fonts, timeoutMs } = request;

    // 1. Fonts first: FontCache measures glyphs with canvas measureText, and a
    //    late font swap would silently invalidate every line break.
    const missingFonts = await awaitFonts(fonts, timeoutMs);

    // 2. Data model + layout.
    let skeleton: DocumentSkeleton;
    let pages: IDocumentSkeletonPage[];
    let canvasColorService: CanvasColorService;
    const layoutStart = performance.now();
    try {
        const dataModel = new DocumentDataModel(snapshot as Partial<IDocumentData>);
        const viewModel = new DocumentViewModel(dataModel);
        // A throw-away Univer instance gives us a correctly-wired LocaleService
        // (DocumentSkeleton needs it for list glyphs / hyphenation language).
        const univer = new Univer({ locale: snapshot.locale ?? LocaleType.EN_US });
        const injector = univer.__getInjector();
        const localeService = injector.get(LocaleService);
        canvasColorService = new CanvasColorService(injector.get(ThemeService));
        skeleton = DocumentSkeleton.create(viewModel, localeService);
        skeleton.calculate();
        const data = skeleton.getSkeletonData();
        if (!data || data.pages.length === 0) {
            return { ok: false, code: 'LAYOUT_FAILED', message: 'DocumentSkeleton produced no pages' };
        }
        pages = data.pages;
    } catch (error) {
        return fail('LAYOUT_FAILED', error);
    }
    const layoutMs = performance.now() - layoutStart;

    // 3. Paint.
    const paintStart = performance.now();
    const painted: IPaintedPage[] = [];
    try {
        const documents = new Documents('univer-headless-doc', skeleton, {
            pageMarginLeft: 0,
            pageMarginTop: 0,
            pageLayoutType: PageLayoutType.VERTICAL,
            hasEditor: false,
        });

        pages.forEach((page, index) => {
            const metrics = pageMetrics(page, index);
            if (mode === 'svg') {
                const ctx = createSvgContext(metrics.width, metrics.height);
                paintPage(documents, pages, index, ctx, canvasColorService);
                const svg = ctx.getSvg();
                svg.setAttribute('width', String(metrics.width));
                svg.setAttribute('height', String(metrics.height));
                svg.setAttribute('viewBox', `0 0 ${metrics.width} ${metrics.height}`);
                painted.push({ metrics, element: svg as unknown as HTMLElement });
            } else {
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(metrics.width * dpr);
                canvas.height = Math.round(metrics.height * dpr);
                canvas.style.width = `${metrics.width}px`;
                canvas.style.height = `${metrics.height}px`;
                const ctx = canvas.getContext('2d')!;
                ctx.scale(dpr, dpr);
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, metrics.width, metrics.height);
                paintPage(documents, pages, index, ctx, canvasColorService);
                painted.push({ metrics, element: canvas });
            }
        });
    } catch (error) {
        return fail('PAINT_FAILED', error);
    }
    const paintMs = performance.now() - paintStart;

    // 4. Mount into the DOM for CDP printing.
    const host = document.getElementById('pages');
    if (host) host.replaceChildren();
    for (const p of painted) mountPage(p.element, p.metrics);

    // Let layout settle one frame before the harness prints.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    return {
        ok: true,
        pages: painted.map((p) => p.metrics),
        layoutMs,
        paintMs,
        missingFonts,
        univerVersion: __UNIVER_VERSION__,
    };
}

window[BROWSER_ENTRY_GLOBAL] = render;
window[BROWSER_READY_GLOBAL] = true;
