/**
 * A CanvasRenderingContext2D-compatible recorder that emits SVG.
 *
 * Wraps `canvas2svg` and adds the pieces `@univerjs/engine-render`'s
 * `UniverRenderingContext2D` relies on but canvas2svg does not implement:
 *
 *   - a tracked current transform matrix (`getTransform`, `setTransform`,
 *     `resetTransform`) with a proper save/restore stack;
 *   - `canvas`, `fontKerning`, `letterSpacing`, `textRendering`,
 *     `getContextAttributes`, `isContextLost`, `roundRect`, `ellipse`.
 *
 * Everything else is forwarded to canvas2svg unchanged.
 */

import C2S from 'canvas2svg';

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
    // m * n  (apply n first, then m) - matches ctx.transform semantics
    return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

function invert(m: Matrix): Matrix {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det) return IDENTITY;
    const a = m[3] / det;
    const b = -m[1] / det;
    const c = -m[2] / det;
    const d = m[0] / det;
    const e = -(a * m[4] + c * m[5]);
    const f = -(b * m[4] + d * m[5]);
    return [a, b, c, d, e, f];
}

function toDOMMatrix(m: Matrix): DOMMatrix {
    return new DOMMatrix(m);
}

export interface ISvgRecordingContext extends CanvasRenderingContext2D {
    getSvg(): SVGSVGElement;
    getSerializedSvg(fixNamedEntities?: boolean): string;
}

export function createSvgContext(width: number, height: number): ISvgRecordingContext {
    const raw = new C2S({ width, height, document }) as unknown as Record<string, unknown> & {
        save(): void;
        restore(): void;
        translate(x: number, y: number): void;
        scale(x: number, y: number): void;
        rotate(a: number): void;
        transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
        beginPath(): void;
        moveTo(x: number, y: number): void;
        lineTo(x: number, y: number): void;
        arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
        closePath(): void;
        arc(x: number, y: number, r: number, s: number, e: number, ccw?: boolean): void;
        clip(): void;
        stroke(): void;
        __applyCurrentDefaultPath(): void;
        __currentElement: Element;
    };

    let ctm: Matrix = [...IDENTITY];
    const stack: Matrix[] = [];
    let lineDash: number[] = [];

    const fakeCanvas = document.createElement('canvas');
    fakeCanvas.width = width;
    fakeCanvas.height = height;

    const extras: Record<string, unknown> = {
        canvas: fakeCanvas,
        fontKerning: 'auto',
        letterSpacing: '0px',
        wordSpacing: '0px',
        textRendering: 'auto',
        direction: 'ltr',
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'low',
        filter: 'none',
        getContextAttributes: () => ({ alpha: true, colorSpace: 'srgb', desynchronized: false, willReadFrequently: false }),
        isContextLost: () => false,
        getTransform: () => toDOMMatrix(ctm),
        save: () => {
            stack.push([...ctm]);
            raw.save();
        },
        restore: () => {
            const prev = stack.pop();
            if (prev) ctm = prev;
            raw.restore();
        },
        translate: (x: number, y: number) => {
            ctm = multiply(ctm, [1, 0, 0, 1, x, y]);
            raw.translate(x, y);
        },
        scale: (x: number, y = x) => {
            ctm = multiply(ctm, [x, 0, 0, y, 0, 0]);
            raw.scale(x, y);
        },
        rotate: (angle: number) => {
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            ctm = multiply(ctm, [cos, sin, -sin, cos, 0, 0]);
            raw.rotate(angle);
        },
        transform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
            ctm = multiply(ctm, [a, b, c, d, e, f]);
            raw.transform(a, b, c, d, e, f);
        },
        setTransform: (...args: unknown[]) => {
            let target: Matrix;
            if (args.length === 1 && args[0] && typeof args[0] === 'object') {
                const m = args[0] as DOMMatrix2DInit;
                target = [m.a ?? m.m11 ?? 1, m.b ?? m.m12 ?? 0, m.c ?? m.m21 ?? 0, m.d ?? m.m22 ?? 1, m.e ?? m.m41 ?? 0, m.f ?? m.m42 ?? 0];
            } else if (args.length >= 6) {
                target = args.slice(0, 6) as Matrix;
            } else {
                target = [...IDENTITY];
            }
            // canvas2svg only supports relative transforms: apply inverse(ctm) * target.
            const delta = multiply(invert(ctm), target);
            ctm = target;
            raw.transform(delta[0], delta[1], delta[2], delta[3], delta[4], delta[5]);
        },
        resetTransform: () => {
            (extras.setTransform as (...a: number[]) => void)(1, 0, 0, 1, 0, 0);
        },
        roundRect: (x: number, y: number, w: number, h: number, radii: number | number[] = 0) => {
            const r = Math.min(Array.isArray(radii) ? (radii[0] ?? 0) : radii, w / 2, h / 2);
            raw.moveTo(x + r, y);
            raw.arcTo(x + w, y, x + w, y + h, r);
            raw.arcTo(x + w, y + h, x, y + h, r);
            raw.arcTo(x, y + h, x, y, r);
            raw.arcTo(x, y, x + w, y, r);
            raw.closePath();
        },
        ellipse: (x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number, ccw?: boolean) => {
            // Approximate with a scaled arc.
            (extras.save as () => void)();
            (extras.translate as (x: number, y: number) => void)(x, y);
            (extras.rotate as (a: number) => void)(rotation);
            (extras.scale as (x: number, y: number) => void)(rx, ry);
            raw.arc(0, 0, 1, start, end, ccw);
            (extras.restore as () => void)();
        },
        /**
         * canvas2svg's clip() moves the current <path> into a <clipPath> but never
         * flushes the accumulated path data onto it, producing an empty clip that
         * hides everything. Flush first, then delegate.
         */
        clip: () => {
            if (raw.__currentElement?.nodeName === 'path') {
                raw.__applyCurrentDefaultPath();
                // An empty clip (no path commands) would clip everything away; skip it.
                if (!raw.__currentElement.getAttribute('d')) return;
            }
            raw.clip();
        },
        /**
         * Canvas treats an all-zero dash array as "solid"; SVG's stroke-dasharray="0"
         * renders nothing. Normalise to an empty array (solid).
         */
        setLineDash: (dash: number[]) => {
            lineDash = dash.every((d) => !d) ? [] : [...dash];
        },
        getLineDash: () => [...lineDash],
        lineDashOffset: 0,
        stroke: () => {
            raw.stroke();
            const el = raw.__currentElement;
            if (el?.nodeName === 'path') {
                if (lineDash.length) el.setAttribute('stroke-dasharray', lineDash.join(' '));
                else el.removeAttribute('stroke-dasharray');
            }
        },
        createConicGradient: () => ({ addColorStop: () => {} }),
        getImageData: () => new ImageData(1, 1),
        putImageData: () => {},
        createImageData: (w: number, h: number) => new ImageData(w, h),
        drawFocusIfNeeded: () => {},
        scrollPathIntoView: () => {},
        isPointInPath: () => false,
        isPointInStroke: () => false,
        reset: () => {
            ctm = [...IDENTITY];
            stack.length = 0;
        },
    };

    return new Proxy(raw, {
        get(target, prop, receiver) {
            if (prop in extras) return extras[prop as string];
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, prop, value) {
            if (prop in extras && typeof extras[prop as string] !== 'function') {
                extras[prop as string] = value;
                return true;
            }
            return Reflect.set(target, prop, value);
        },
    }) as unknown as ISvgRecordingContext;
}
