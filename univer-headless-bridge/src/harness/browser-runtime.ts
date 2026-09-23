/**
 * Headless browser runner.
 *
 * Boots an isolated Chromium page, injects the pre-built Univer web bundle
 * (dist/web/univer-runtime.js), hands it a snapshot, waits for layout + paint
 * to converge, then prints the mounted pages to a vector PDF through CDP
 * (`page.pdf`).
 *
 * Nothing from @univerjs is imported here on purpose: the Node process never
 * touches engine-render (it needs Canvas / DOM / font metrics).
 */

import type { Browser, BrowserContext, LaunchOptions, Page } from 'playwright';
import type { IDocumentData } from '@univerjs/core';
import type { IPageMetrics, IRenderRequest, IRenderResult, RenderMode, RenderOutcome } from '../schema/render-request.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { BROWSER_READY_GLOBAL } from '../schema/render-request.js';

export interface IRenderPdfOptions {
    /** Absolute or cwd-relative path of the PDF to write. */
    outputPath: string;
    mode?: RenderMode;
    /** Device pixel ratio for `mode: 'canvas'`. Default 2. */
    dpr?: number;
    /** Extra font families to await before layout. Default: families referenced by the snapshot. */
    fonts?: string[];
    /** Hard timeout for the whole browser phase. Default 60_000. */
    timeoutMs?: number;
    /** Print CSS backgrounds (page fill, shading). Default true. */
    printBackground?: boolean;
    /** Override Chromium executable (also honoured: env UNIVER_BRIDGE_CHROMIUM). */
    executablePath?: string;
    /** Keep the browser open and write debug artefacts (page HTML) next to the PDF. */
    debug?: boolean;
    /** Emit progress lines to stderr. */
    log?: (line: string) => void;
}

export interface IRenderPdfResult extends IRenderResult {
    outputPath: string;
    bytes: number;
    browserVersion: string;
    executablePath: string;
    totalMs: number;
}

export class UniverBridgeError extends Error {
    constructor(
        readonly code: 'BUNDLE_MISSING' | 'BROWSER_LAUNCH_FAILED' | 'RUNTIME_NOT_READY' | 'RENDER_TIMEOUT' | Extract<RenderOutcome, { ok: false }>['code'],
        message: string,
        readonly detail?: string
    ) {
        super(message);
        this.name = 'UniverBridgeError';
    }
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Works both from src/ (tsx) and dist/ (tsc) because both are one level below the package root.
const PACKAGE_ROOT = path.resolve(here, '..', '..');
const WEB_BUNDLE = path.join(PACKAGE_ROOT, 'dist', 'web', 'univer-runtime.js');

// ---------------------------------------------------------------------------
// Chromium resolution
// ---------------------------------------------------------------------------
interface IResolvedBrowser {
    executablePath: string | undefined;
    args: string[];
    env: Record<string, string>;
    source: 'option' | 'env' | 'playwright' | 'sparticuz';
}

/**
 * Order: explicit option -> env UNIVER_BRIDGE_CHROMIUM -> Playwright-managed
 * Chromium -> @sparticuz/chromium (npm-distributed binary, useful where the
 * Playwright CDN is unreachable).
 */
export async function resolveChromium(explicit?: string): Promise<IResolvedBrowser> {
    if (explicit) return { executablePath: explicit, args: [], env: {}, source: 'option' };
    const fromEnv = process.env.UNIVER_BRIDGE_CHROMIUM;
    if (fromEnv) return { executablePath: fromEnv, args: [], env: {}, source: 'env' };

    const managed = chromium.executablePath();
    if (managed && existsSync(managed)) return { executablePath: undefined, args: [], env: {}, source: 'playwright' };

    try {
        const mod = await import('@sparticuz/chromium');
        const sparticuz = (mod.default ?? mod) as {
            executablePath(): Promise<string>;
            args: string[];
        };
        const executablePath = await sparticuz.executablePath();
        // sparticuz ships its NSS/NSPR + fontconfig alongside; expose them.
        const tmp = path.dirname(executablePath);
        const env: Record<string, string> = {};
        const libDir = path.join(tmp, 'al2023', 'lib');
        if (existsSync(libDir)) {
            env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
        }
        const fontsDir = path.join(tmp, 'fonts');
        if (existsSync(fontsDir)) {
            env.FONTCONFIG_PATH = fontsDir;
        }
        return {
            executablePath,
            args: sparticuz.args.filter((a) => a !== '--single-process' && !a.startsWith('--headless')),
            env,
            source: 'sparticuz',
        };
    } catch (error) {
        throw new UniverBridgeError(
            'BROWSER_LAUNCH_FAILED',
            'No Chromium found. Run `pnpm exec playwright install chromium`, set UNIVER_BRIDGE_CHROMIUM=/path/to/chrome, or install the optional @sparticuz/chromium package.',
            error instanceof Error ? error.message : String(error)
        );
    }
}

// ---------------------------------------------------------------------------
// Page document
// ---------------------------------------------------------------------------
/**
 * Univer's canvas font string always ends with a fixed fallback chain
 * ("Helvetica Neue", Helvetica, Arial, "PingFang SC", ..., "WenQuanYi Micro Hei", sans-serif).
 * Headless Linux images usually have none of those, so bullets (●○■), check
 * boxes and arrows silently drop. We register DejaVu Sans (bundled via the
 * `dejavu-fonts-ttf` npm package) under the last named slot of that chain so
 * symbol glyphs resolve before the generic `sans-serif` does. Latin text still
 * uses the requested family when it is available.
 */
async function fallbackFontFaces(): Promise<string> {
    const dir = path.join(PACKAGE_ROOT, 'node_modules', 'dejavu-fonts-ttf', 'ttf');
    const faces: Array<[string, string, string]> = [
        ['DejaVuSans.ttf', 'normal', 'normal'],
        ['DejaVuSans-Bold.ttf', 'bold', 'normal'],
        ['DejaVuSans-Oblique.ttf', 'normal', 'italic'],
        ['DejaVuSans-BoldOblique.ttf', 'bold', 'italic'],
    ];
    const css: string[] = [];
    for (const [file, weight, style] of faces) {
        const full = path.join(dir, file);
        if (!existsSync(full)) continue;
        const b64 = (await readFile(full)).toString('base64');
        for (const family of ['WenQuanYi Micro Hei', 'Univer Symbol Fallback']) {
            css.push(`@font-face{font-family:"${family}";font-weight:${weight};font-style:${style};src:url(data:font/ttf;base64,${b64}) format("truetype");}`);
        }
    }
    return css.join('\n');
}

function pageHtml(): string {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>univer-headless-bridge</title>
<style>
  html, body { margin: 0; padding: 0; background: #fff; }
  #pages { display: block; }
  .univer-page { display: block; position: relative; overflow: hidden; background: #fff; break-after: page; page-break-after: always; }
  .univer-page:last-child { break-after: auto; page-break-after: auto; }
  .univer-page > svg, .univer-page > canvas { display: block; position: absolute; left: 0; top: 0; }
  @media print { html, body { width: auto; height: auto; } }
</style></head>
<body><div id="pages"></div></body></html>`;
}

function collectFonts(snapshot: IDocumentData): string[] {
    const families = new Set<string>();
    const push = (ff: unknown) => {
        if (typeof ff === 'string' && ff.trim()) families.add(ff.split(',')[0]!.trim().replace(/^["']|["']$/g, ''));
    };
    push(snapshot.documentStyle?.textStyle?.ff);
    for (const run of snapshot.body?.textRuns ?? []) push(run.ts?.ff);
    return [...families];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
export async function renderSnapshotToPdf(snapshot: IDocumentData, options: IRenderPdfOptions): Promise<IRenderPdfResult> {
    const started = Date.now();
    const log = options.log ?? (() => {});
    const mode: RenderMode = options.mode ?? 'svg';
    const timeoutMs = options.timeoutMs ?? 60_000;

    if (!existsSync(WEB_BUNDLE)) {
        throw new UniverBridgeError('BUNDLE_MISSING', `Web bundle not found at ${WEB_BUNDLE}. Run \`pnpm run build:web\`.`);
    }
    const bundle = await readFile(WEB_BUNDLE, 'utf8');

    const resolved = await resolveChromium(options.executablePath);
    log(`chromium: ${resolved.source}${resolved.executablePath ? ` (${resolved.executablePath})` : ''}`);

    const launch: LaunchOptions = {
        headless: true,
        executablePath: resolved.executablePath,
        args: [
            ...resolved.args,
            '--font-render-hinting=none',
            '--disable-gpu',
            '--no-sandbox',
            '--force-device-scale-factor=1',
        ],
        env: { ...process.env, ...resolved.env } as Record<string, string>,
        timeout: timeoutMs,
    };

    let browser: Browser;
    try {
        browser = await chromium.launch(launch);
    } catch (error) {
        throw new UniverBridgeError('BROWSER_LAUNCH_FAILED', 'Chromium failed to launch.', error instanceof Error ? error.message : String(error));
    }

    let context: BrowserContext | undefined;
    try {
        context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1200, height: 1600 } });
        const page: Page = await context.newPage();
        page.setDefaultTimeout(timeoutMs);

        const consoleLines: string[] = [];
        page.on('console', (msg) => {
            const line = `[browser:${msg.type()}] ${msg.text()}`;
            consoleLines.push(line);
            if (options.debug) log(line);
        });
        page.on('pageerror', (err) => consoleLines.push(`[browser:pageerror] ${err.message}`));

        await page.setContent(pageHtml(), { waitUntil: 'domcontentloaded' });
        await page.addStyleTag({ content: await fallbackFontFaces() });
        await page.evaluate(() => document.fonts.load('12px "WenQuanYi Micro Hei"').then(() => document.fonts.ready));
        await page.addScriptTag({ content: bundle });
        await page.waitForFunction((flag) => (window as unknown as Record<string, unknown>)[flag] === true, BROWSER_READY_GLOBAL, { timeout: 10_000 })
            .catch(() => {
                throw new UniverBridgeError('RUNTIME_NOT_READY', 'Univer web runtime did not initialise.', consoleLines.join('\n'));
            });

        const request: IRenderRequest = {
            snapshot,
            mode,
            dpr: options.dpr ?? 2,
            fonts: options.fonts ?? collectFonts(snapshot),
            timeoutMs: Math.min(timeoutMs, 15_000),
        };

        log(`render: mode=${mode} fonts=[${request.fonts.join(', ')}]`);
        const outcome = await Promise.race<RenderOutcome>([
            page.evaluate((req) => window.__univerHeadlessRender!(req), request),
            new Promise<never>((_, reject) => setTimeout(() => reject(new UniverBridgeError('RENDER_TIMEOUT', `Render exceeded ${timeoutMs} ms`)), timeoutMs)),
        ]);

        if (!outcome.ok) {
            throw new UniverBridgeError(outcome.code, outcome.message, [outcome.stack, ...consoleLines].filter(Boolean).join('\n'));
        }
        log(`layout: ${outcome.pages.length} page(s) in ${outcome.layoutMs.toFixed(1)} ms, paint ${outcome.paintMs.toFixed(1)} ms`);
        if (outcome.missingFonts.length) log(`warning: fonts not confirmed loaded: ${outcome.missingFonts.join(', ')}`);

        // Wait for fonts inside the SVG / canvases to be ready and one paint to flush.
        await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => r(undefined)))));

        const outputPath = path.resolve(options.outputPath);
        await mkdir(path.dirname(outputPath), { recursive: true });

        if (options.debug) {
            const html = await page.content();
            await writeFile(outputPath.replace(/\.pdf$/i, '') + '.debug.html', html, 'utf8');
        }

        const pdfBuffer = await printPages(page, outcome.pages, options.printBackground ?? true);
        await writeFile(outputPath, pdfBuffer);

        return {
            ...outcome,
            outputPath,
            bytes: pdfBuffer.byteLength,
            browserVersion: browser.version(),
            executablePath: resolved.executablePath ?? chromium.executablePath(),
            totalMs: Date.now() - started,
        };
    } finally {
        if (!options.debug) {
            await context?.close().catch(() => {});
            await browser.close().catch(() => {});
        }
    }
}

/**
 * All pages of a Univer document share the section page size in the common
 * case, so a single `page.pdf` with an explicit width/height is enough. Mixed
 * sizes (landscape sections) fall back to per-page printing + concatenation
 * is out of scope for the day-one deliverable; we print with the first page's
 * size and let CSS `break-after: page` split the rest.
 */
async function printPages(page: Page, pages: IPageMetrics[], printBackground: boolean): Promise<Buffer> {
    const first = pages[0]!;
    await page.emulateMedia({ media: 'print' });
    await page.addStyleTag({
        content: `@page { size: ${first.width}px ${first.height}px; margin: 0; }`,
    });
    return page.pdf({
        width: `${first.width}px`,
        height: `${first.height}px`,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
        printBackground,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        scale: 1,
    });
}

export const paths = { PACKAGE_ROOT, WEB_BUNDLE };
