export type EditorTool = 'draw' | 'select';
export type LineKind = 'line' | 'wall';
export type MeasurementUnit = 'cm' | 'inch';

export interface VectorPoint {
  x: number;
  y: number;
}

export interface VectorLine {
  id: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  kind: LineKind;
}

export interface GuideLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: 'axis' | 'alignment' | 'endpoint' | 'angle';
}

export const TABLE_WIDTH_CM = 200;
export const TABLE_HEIGHT_CM = 100;

/** Raster export size used by backend persistence. */
export const MAP_WIDTH = 79;
export const MAP_HEIGHT = 40;

export const CM_PER_PIXEL_X = TABLE_WIDTH_CM / MAP_WIDTH;
export const CM_PER_PIXEL_Y = TABLE_HEIGHT_CM / MAP_HEIGHT;

export const CM_PER_INCH = 2.54;

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 24;
export const ZOOM_STEP = 0.25;
export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24];

export const TOOL_OPTIONS: { value: EditorTool; labelKey: string; icon: string }[] = [
  { value: 'draw', labelKey: 'FLOWCHART.TABLE_TOOL_DRAW', icon: 'pi pi-pencil' },
  { value: 'select', labelKey: 'FLOWCHART.TABLE_TOOL_SELECT', icon: 'pi pi-mouse' },
];

export const LINE_KIND_OPTIONS: { value: LineKind; labelKey: string }[] = [
  { value: 'line', labelKey: 'FLOWCHART.TABLE_LINE_TYPE_LINE' },
  { value: 'wall', labelKey: 'FLOWCHART.TABLE_LINE_TYPE_WALL' },
];

export const UNIT_OPTIONS: { value: MeasurementUnit; labelKey: string }[] = [
  { value: 'cm', labelKey: 'FLOWCHART.TABLE_UNIT_CM' },
  { value: 'inch', labelKey: 'FLOWCHART.TABLE_UNIT_INCH' },
];

export function clampToTable(point: VectorPoint): VectorPoint {
  return {
    x: Math.max(0, Math.min(TABLE_WIDTH_CM, point.x)),
    y: Math.max(0, Math.min(TABLE_HEIGHT_CM, point.y)),
  };
}

export function lineLengthCm(line: Pick<VectorLine, 'startX' | 'startY' | 'endX' | 'endY'>): number {
  const dx = line.endX - line.startX;
  const dy = line.endY - line.startY;
  return Math.hypot(dx, dy);
}

export function roundTo(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function convertFromCm(valueCm: number, unit: MeasurementUnit): number {
  if (unit === 'inch') {
    return valueCm / CM_PER_INCH;
  }
  return valueCm;
}

export function convertToCm(value: number, unit: MeasurementUnit): number {
  if (unit === 'inch') {
    return value * CM_PER_INCH;
  }
  return value;
}

export function formatDistance(valueCm: number, unit: MeasurementUnit): string {
  const converted = convertFromCm(valueCm, unit);
  const rounded = roundTo(converted, converted >= 100 ? 1 : 2);
  return `${rounded} ${unit}`;
}

export function pixelToTableY(pixelY: number): number {
  return TABLE_HEIGHT_CM - pixelY * CM_PER_PIXEL_Y;
}

export function tableToPixelY(yCm: number): number {
  return (TABLE_HEIGHT_CM - yCm) / CM_PER_PIXEL_Y;
}

export function pointToSegmentDistanceCm(point: VectorPoint, line: VectorLine): number {
  const vx = line.endX - line.startX;
  const vy = line.endY - line.startY;
  const wx = point.x - line.startX;
  const wy = point.y - line.startY;

  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(point.x - line.startX, point.y - line.startY);

  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(point.x - line.endX, point.y - line.endY);

  const b = c1 / c2;
  const px = line.startX + b * vx;
  const py = line.startY + b * vy;
  return Math.hypot(point.x - px, point.y - py);
}
