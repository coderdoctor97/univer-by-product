#!/usr/bin/env node
/**
 * univer-pdf CLI
 *
 *   univer-pdf --input doc.md --output doc.pdf
 *   univer-pdf --input doc.md --dump-snapshot doc.snapshot.json
 *   univer-pdf --input snapshot.json --output doc.pdf        (pre-built IDocumentData)
 *
 * Exit codes: 0 ok, 2 invalid input / options, 3 browser or render failure.
 * With --json the last stdout line is a machine-readable result object.
 */

import type { IDocumentData } from '@univerjs/core';
import type { PaperPreset } from './adapter/markdown-to-univer.js';
import type { RenderMode } from './schema/render-request.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Command, InvalidArgumentError } from 'commander';
import { z } from 'zod';
import { assertSnapshotInvariants, markdownToUniver } from './adapter/markdown-to-univer.js';
import { renderSnapshotToPdf, UniverBridgeError } from './harness/browser-runtime.js';

const PAPERS = ['A4', 'Letter', 'Legal', 'A3', 'A5'] as const;
const MODES = ['svg', 'canvas'] as const;

const OptionsSchema = z.object({
    input: z.string().min(1),
    output: z.string().optional(),
    dumpSnapshot: z.union([z.string(), z.boolean()]).optional(),
    paper: z.enum(PAPERS).default('A4'),
    margin: z.number().min(0).max(400).default(72),
    font: z.string().default('Arial'),
    codeFont: z.string().default('Courier New'),
    fontSize: z.number().min(6).max(72).default(11),
    title: z.string().optional(),
    mode: z.enum(MODES).default('svg'),
    dpr: z.number().min(1).max(4).default(2),
    timeout: z.number().int().min(1000).default(60_000),
    chromium: z.string().optional(),
    json: z.boolean().default(false),
    debug: z.boolean().default(false),
    verbose: z.boolean().default(false),
}).refine((o) => o.output || o.dumpSnapshot, { message: 'Provide --output <file.pdf> and/or --dump-snapshot [file.json]' });

type Options = z.infer<typeof OptionsSchema>;

function numberArg(value: string): number {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new InvalidArgumentError('Expected a number.');
    return n;
}

const SnapshotShape = z.object({
    id: z.string(),
    documentStyle: z.object({}).passthrough(),
    body: z.object({ dataStream: z.string() }).passthrough(),
}).passthrough();

async function loadSnapshot(opts: Options): Promise<{ snapshot: IDocumentData; source: 'markdown' | 'json' }> {
    const inputPath = path.resolve(opts.input);
    const raw = await readFile(inputPath, 'utf8');
    if (/\.json$/i.test(inputPath)) {
        const parsed = SnapshotShape.safeParse(JSON.parse(raw));
        if (!parsed.success) {
            throw new UniverBridgeError('INVALID_SNAPSHOT', `Input JSON is not an IDocumentData snapshot: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
        }
        return { snapshot: parsed.data as unknown as IDocumentData, source: 'json' };
    }
    const snapshot = markdownToUniver(raw, {
        id: path.basename(inputPath).replace(/\.[^.]+$/, ''),
        title: opts.title ?? path.basename(inputPath),
        paper: opts.paper as PaperPreset,
        margin: opts.margin,
        fontFamily: opts.font,
        codeFontFamily: opts.codeFont,
        fontSize: opts.fontSize,
    });
    return { snapshot, source: 'markdown' };
}

async function main(argv: string[]): Promise<number> {
    const program = new Command()
        .name('univer-pdf')
        .description('Render Markdown (or a Univer IDocumentData JSON snapshot) to a vector PDF through Univer\'s headless layout engine.')
        .requiredOption('-i, --input <file>', 'input .md or .json snapshot')
        .option('-o, --output <file.pdf>', 'output PDF path')
        .option('--dump-snapshot [file.json]', 'write the generated IDocumentData snapshot (default: <output>.snapshot.json or stdout)')
        .option('--paper <preset>', `page preset: ${PAPERS.join('|')}`, 'A4')
        .option('--margin <px>', 'page margin in 96-dpi px (72 = 0.75in)', numberArg, 72)
        .option('--font <family>', 'body font family', 'Arial')
        .option('--code-font <family>', 'monospace font family', 'Courier New')
        .option('--font-size <pt>', 'body font size in pt', numberArg, 11)
        .option('--title <text>', 'document title metadata')
        .option('--mode <mode>', `render mode: ${MODES.join('|')} (svg = vector text)`, 'svg')
        .option('--dpr <n>', 'device pixel ratio for canvas mode', numberArg, 2)
        .option('--timeout <ms>', 'browser phase timeout', numberArg, 60_000)
        .option('--chromium <path>', 'explicit Chromium executable')
        .option('--json', 'print a machine-readable JSON result as the last stdout line', false)
        .option('--debug', 'keep browser artefacts (.debug.html) and echo browser console', false)
        .option('-v, --verbose', 'progress logging on stderr', false)
        .showHelpAfterError()
        .exitOverride();

    let opts: Options;
    try {
        program.parse(argv);
        const parsed = OptionsSchema.safeParse(program.opts());
        if (!parsed.success) {
            process.stderr.write(`error: ${parsed.error.issues.map((i) => i.message).join('; ')}\n`);
            return 2;
        }
        opts = parsed.data;
    } catch (error) {
        // commander already printed help / error
        const code = (error as { exitCode?: number }).exitCode;
        return code === 0 ? 0 : 2;
    }

    const log = (line: string) => {
        if (opts.verbose || opts.debug) process.stderr.write(`[univer-pdf] ${line}\n`);
    };

    try {
        const { snapshot, source } = await loadSnapshot(opts);
        assertSnapshotInvariants(snapshot);
        log(`snapshot: source=${source} chars=${snapshot.body!.dataStream.length} paragraphs=${snapshot.body!.paragraphs?.length ?? 0}`);

        if (opts.dumpSnapshot) {
            const json = JSON.stringify(snapshot, null, 2);
            const writeJson = async (target: string) => {
                await mkdir(path.dirname(target), { recursive: true });
                await writeFile(target, json, 'utf8');
            };
            if (typeof opts.dumpSnapshot === 'string') {
                await writeJson(path.resolve(opts.dumpSnapshot));
                log(`snapshot written: ${path.resolve(opts.dumpSnapshot)}`);
            } else if (opts.output) {
                const target = path.resolve(opts.output).replace(/\.pdf$/i, '') + '.snapshot.json';
                await writeJson(target);
                log(`snapshot written: ${target}`);
            } else {
                process.stdout.write(json + '\n');
            }
        }

        if (!opts.output) return 0;

        const result = await renderSnapshotToPdf(snapshot, {
            outputPath: opts.output,
            mode: opts.mode as RenderMode,
            dpr: opts.dpr,
            timeoutMs: opts.timeout,
            executablePath: opts.chromium,
            debug: opts.debug,
            log,
        });

        const summary = {
            ok: true as const,
            output: result.outputPath,
            bytes: result.bytes,
            pages: result.pages.length,
            pageSize: { width: result.pages[0]?.width, height: result.pages[0]?.height },
            mode: opts.mode,
            layoutMs: Math.round(result.layoutMs),
            paintMs: Math.round(result.paintMs),
            totalMs: result.totalMs,
            missingFonts: result.missingFonts,
            univerVersion: result.univerVersion,
            browserVersion: result.browserVersion,
        };
        if (opts.json) {
            process.stdout.write(JSON.stringify(summary) + '\n');
        } else {
            process.stdout.write(`✔ ${summary.pages} page(s) → ${summary.output} (${summary.bytes} bytes, ${summary.totalMs} ms)\n`);
            if (summary.missingFonts.length) process.stdout.write(`  ⚠ fonts not available in browser: ${summary.missingFonts.join(', ')}\n`);
        }
        return 0;
    } catch (error) {
        const bridgeError = error instanceof UniverBridgeError ? error : undefined;
        const payload = {
            ok: false as const,
            code: bridgeError?.code ?? 'UNEXPECTED',
            message: error instanceof Error ? error.message : String(error),
            detail: bridgeError?.detail,
        };
        if (opts.json) {
            process.stdout.write(JSON.stringify(payload) + '\n');
        } else {
            process.stderr.write(`✘ ${payload.code}: ${payload.message}\n`);
            if (payload.detail && (opts.verbose || opts.debug)) process.stderr.write(`${payload.detail}\n`);
        }
        return payload.code === 'INVALID_SNAPSHOT' ? 2 : 3;
    }
}

main(process.argv).then((code) => process.exit(code));
