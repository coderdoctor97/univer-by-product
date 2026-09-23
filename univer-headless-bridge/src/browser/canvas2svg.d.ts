declare module 'canvas2svg' {
    interface C2SOptions {
        width?: number;
        height?: number;
        document?: Document;
        ctx?: CanvasRenderingContext2D;
        enableMirroring?: boolean;
    }
    class C2S {
        constructor(options?: C2SOptions);
        getSvg(): SVGSVGElement;
        getSerializedSvg(fixNamedEntities?: boolean): string;
    }
    export default C2S;
}
