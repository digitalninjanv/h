declare module 'imagetracerjs' {
  export type ImageTracerOptions = Record<string, unknown> | string;

  export function imagedataToSVG(imageData: ImageData, options?: ImageTracerOptions): string;
}
