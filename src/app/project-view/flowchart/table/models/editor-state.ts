/** Drawing tool types */
export type DrawingTool = 'brush' | 'line' | 'eraser';

/** Paint color types */
export type PaintColor = 'white' | 'black' | 'gray';

/** Editor state interface */
export interface EditorState {
  zoom: number;
  panOffset: { x: number; y: number };
  showGrid: boolean;
  activeTool: DrawingTool;
  selectedColor: PaintColor;
}

/** Map dimensions in pixels */
export const MAP_WIDTH = 79;
export const MAP_HEIGHT = 40;

/** Zoom constraints */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = Infinity;
export const ZOOM_STEP = 0.25;

/** Available zoom levels for dropdown */
export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 10, 12, 16, 20];

/** Default editor state */
export const DEFAULT_EDITOR_STATE: EditorState = {
  zoom: 8, // Start at 8x zoom (800%)
  panOffset: { x: 0, y: 0 },
  showGrid: true,
  activeTool: 'brush',
  selectedColor: 'black',
};

/** Color options for UI */
export const COLOR_OPTIONS: { value: PaintColor; labelKey: string; hex: string }[] = [
  { value: 'white', labelKey: 'FLOWCHART.TABLE_COLOR_GROUND', hex: '#ffffff' },
  { value: 'black', labelKey: 'FLOWCHART.TABLE_COLOR_LINE', hex: '#000000' },
  { value: 'gray', labelKey: 'FLOWCHART.TABLE_COLOR_WALL', hex: '#808080' },
];

/** Tool options for UI */
export const TOOL_OPTIONS: { value: DrawingTool; labelKey: string; icon: string }[] = [
  { value: 'brush', labelKey: 'FLOWCHART.TABLE_TOOL_BRUSH', icon: 'pi pi-pencil' },
  { value: 'line', labelKey: 'FLOWCHART.TABLE_TOOL_LINE', icon: 'pi pi-minus' },
  { value: 'eraser', labelKey: 'FLOWCHART.TABLE_TOOL_ERASER', icon: 'pi pi-eraser' },
];

/** Convert PaintColor to hex string */
export function colorToHex(color: PaintColor): string {
  switch (color) {
    case 'white': return '#ffffff';
    case 'black': return '#000000';
    case 'gray': return '#808080';
  }
}

/** Bresenham's line algorithm - returns array of points */
export function bresenhamLine(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  let x = x0;
  let y = y0;

  while (true) {
    points.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }

  return points;
}
