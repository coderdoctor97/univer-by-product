/**
 * Shared contract between the Node harness and the in-browser Univer runtime.
 *
 * This file is imported by BOTH the Node side (src/harness) and the browser
 * bundle (src/browser), so it must remain free of Node-only or DOM-only APIs.
 */

import type { IDocumentData } from '@univerjs/core';

/** Output vector strategy. */
export type RenderMode =
    /** Univer paints each page into an SVG-recording canvas context; the SVGs are laid out as CSS pages and printed via CDP. Text stays selectable. */
    | 'svg'
    /** Univer paints each page into a real <canvas>; canvases are printed via CDP (raster). Reference / debugging path. */
    | 'canvas';

export interface IRenderRequest {
    snapshot: IDocumentData;
    mode: RenderMode;
    /** Device pixel ratio for canvas mode (ignored for svg). */
    dpr: number;
    /** Font families whose readiness must be awaited before layout. */
    fonts: string[];
    /** Max milliseconds to wait for fonts / layout convergence. */
    timeoutMs: number;
}

export interface IPageMetrics {
    index: number;
    /** Page width in CSS px (96 DPI layout px, same unit as IDocumentData.documentStyle.pageSize). */
    width: number;
    height: number;
    marginTop: number;
    marginLeft: number;
}

export interface IRenderResult {
    ok: true;
    pages: IPageMetrics[];
    /** Wall-clock milliseconds spent in DocumentSkeleton.calculate(). */
    layoutMs: number;
    /** Wall-clock milliseconds spent painting all pages. */
    paintMs: number;
    /** Fonts that were requested but not confirmed loaded by document.fonts. */
    missingFonts: string[];
    univerVersion: string;
}

export interface IRenderFailure {
    ok: false;
    code: 'INVALID_SNAPSHOT' | 'LAYOUT_FAILED' | 'PAINT_FAILED' | 'FONT_TIMEOUT';
    message: string;
    stack?: string;
}

export type RenderOutcome = IRenderResult | IRenderFailure;

/** Name of the global function the browser bundle installs on `window`. */
export const BROWSER_ENTRY_GLOBAL = '__univerHeadlessRender';
/** Name of the global the browser bundle sets once it has finished evaluating. */
export const BROWSER_READY_GLOBAL = '__univerHeadlessReady';

declare global {
    interface Window {
        __univerHeadlessRender?: (request: IRenderRequest) => Promise<RenderOutcome>;
        __univerHeadlessReady?: boolean;
    }
}
