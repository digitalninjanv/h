export type TraceMode = 'auto' | 'logo' | 'photo' | 'flat-icon';

export type QualityPreset = 'draft' | 'balanced' | 'max-detail';

export interface TraceSettings {
  mode: TraceMode;
  quality: QualityPreset;
  backgroundRemove: boolean;
  textPreserve: boolean;
  threshold: number;
  smoothing: number;
  simplification: number;
  colorLimit: number;
  detailLevel: number;
  noiseReduction: number;
  edgePreservation: number;
  maxDimension: number;
}

export interface ImageAnalysis {
  width: number;
  height: number;
  kind: 'logo' | 'photo' | 'text' | 'mixed';
  dominantColors: number;
  edgeDensity: number;
  alphaCoverage: number;
  estimatedComplexity: number;
  textLikelihood: number;
  recommendedMode: TraceMode;
  warnings: string[];
}

export interface TraceResult {
  svg: string;
  previewSvg: string;
  originalWidth: number;
  originalHeight: number;
  outputWidth: number;
  outputHeight: number;
  processingMs: number;
  svgBytes: number;
  textDetected: boolean;
  ocrText: string;
  warnings: string[];
  analysis: ImageAnalysis;
}
