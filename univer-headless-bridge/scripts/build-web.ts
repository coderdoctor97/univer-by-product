/**
 * Bundles src/browser/univer-page-runtime.ts into a single IIFE that the
 * Playwright harness injects into a blank page. Output: dist/web/univer-runtime.js
 */
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const univerVersion: string = JSON.parse(readFileSync(path.join(root, 'node_modules', '@univerjs', 'core', 'package.json'), 'utf8')).version;

const outDir = path.join(root, 'dist', 'web');
await mkdir(outDir, { recursive: true });

const result = await build({
    entryPoints: [path.join(root, 'src', 'browser', 'univer-page-runtime.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    outfile: path.join(outDir, 'univer-runtime.js'),
    sourcemap: false,
    minify: process.env.UNIVER_BRIDGE_MINIFY !== '0',
    legalComments: 'none',
    logLevel: 'info',
    define: {
        'process.env.NODE_ENV': '"production"',
        '__UNIVER_VERSION__': JSON.stringify(univerVersion),
    },
    metafile: true,
});

await writeFile(path.join(outDir, 'meta.json'), JSON.stringify({
    univerVersion,
    builtAt: new Date().toISOString(),
    inputs: Object.keys(result.metafile.inputs).length,
}, null, 2));
