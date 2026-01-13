import { Injectable, signal, computed } from '@angular/core';

export interface MapConfig {
  widthCm: number;
  heightCm: number;
  pixelsPerCm: number;
}

/** Constants: 79px width maps to 200 cm, 40px height maps to 100 cm */
export const CM_PER_PIXEL_X = 200 / 79;
export const CM_PER_PIXEL_Y = 100 / 40;
const CM_PER_PIXEL_AVG = (CM_PER_PIXEL_X + CM_PER_PIXEL_Y) / 2;

/** Line segment in table coordinates (cm) */
export interface LineSegmentCm {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  isDiagonal: boolean;
}

/** Wall segment in table coordinates (cm) */
export interface WallSegmentCm {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  thickness: number;
}

/** Pixel-based line segment */
interface LineSegment {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  isDiagonal: boolean;
}

/** Pixel-based wall segment */
interface WallSegment {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  thickness: number;
}

/** Parsed map data */
interface ParsedMapData {
  width: number;
  height: number;
  lineSegments: LineSegment[];
  wallSegments: WallSegment[];
}

// Color thresholds
const BLACK_THRESHOLD = 50;   // Dark pixels are black lines
const GRAY_MIN = 80;          // Gray pixels are walls
const GRAY_MAX = 180;         // Gray range upper bound

/**
 * Service for loading and querying the game table map.
 * Provides line detection based on the map image and parsed vector data.
 */
@Injectable({ providedIn: 'root' })
export class TableMapService {
  private readonly _mapImage = signal<HTMLImageElement | null>(null);
  private readonly _imageData = signal<ImageData | null>(null);
  private readonly _parsedData = signal<ParsedMapData | null>(null);
  private readonly _isLoading = signal<boolean>(false);
  // Default dimensions: 79x40 pixels mapped to 200x100 cm
  private readonly _config = signal<MapConfig>({
    widthCm: 79 * CM_PER_PIXEL_X,  // 200 cm
    heightCm: 40 * CM_PER_PIXEL_Y, // 100 cm
    pixelsPerCm: 1 / CM_PER_PIXEL_AVG,
  });

  readonly mapImage = this._mapImage.asReadonly();
  readonly config = this._config.asReadonly();
  readonly isLoaded = computed(() => this._mapImage() !== null);
  readonly isLoading = this._isLoading.asReadonly();

  /** Line segments in table coordinates (cm) */
  readonly lineSegmentsCm = computed<LineSegmentCm[]>(() => {
    const data = this._parsedData();
    if (!data) return [];

    return data.lineSegments.map(seg => ({
      ...this.pixelSegmentToTableCm(seg, data.height),
      isDiagonal: seg.isDiagonal,
    }));
  });

  /** Wall segments in table coordinates (cm) */
  readonly wallSegmentsCm = computed<WallSegmentCm[]>(() => {
    const data = this._parsedData();
    if (!data) return [];

    return data.wallSegments.map(seg => ({
      ...this.pixelSegmentToTableCm(seg, data.height),
      thickness: seg.thickness * CM_PER_PIXEL_AVG,
    }));
  });

  private pixelSegmentToTableCm(
    seg: { startX: number; startY: number; endX: number; endY: number },
    imgHeight: number
  ): { startX: number; startY: number; endX: number; endY: number } {
    return {
      startX: seg.startX * CM_PER_PIXEL_X,
      startY: (imgHeight - seg.startY) * CM_PER_PIXEL_Y,
      endX: seg.endX * CM_PER_PIXEL_X,
      endY: (imgHeight - seg.endY) * CM_PER_PIXEL_Y,
    };
  }

  /** Load a map image from a URL */
  async loadMap(url: string): Promise<void> {
    this._isLoading.set(true);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = async () => {
        this._mapImage.set(img);
        this.extractImageData(img);
        const parsedData = await this.parseImage(img);
        this._parsedData.set(parsedData);

        this._config.update(c => ({
          ...c,
          widthCm: img.width * CM_PER_PIXEL_X,
          heightCm: img.height * CM_PER_PIXEL_Y,
          pixelsPerCm: 1 / CM_PER_PIXEL_AVG,
        }));

        this._isLoading.set(false);
        resolve();
      };
      img.onerror = (err) => {
        this._isLoading.set(false);
        reject(err);
      };
      img.src = url;
    });
  }

  /** Load map from a base64 string */
  async loadMapFromBase64(base64: string): Promise<void> {
    return this.loadMap(`data:image/png;base64,${base64}`);
  }

  /** Clear loaded map */
  clear(): void {
    this._mapImage.set(null);
    this._imageData.set(null);
    this._parsedData.set(null);
  }

  private extractImageData(img: HTMLImageElement): void {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    this._imageData.set(ctx.getImageData(0, 0, img.width, img.height));
  }

  /** Check if a position (in table cm) is on a black line */
  isOnBlackLine(xCm: number, yCm: number): boolean {
    const imageData = this._imageData();
    const img = this._mapImage();
    if (!imageData || !img) return false;

    const imgCol = Math.round(xCm / CM_PER_PIXEL_X);
    const imgRow = img.height - 1 - Math.round(yCm / CM_PER_PIXEL_Y);

    if (imgCol < 0 || imgCol >= img.width || imgRow < 0 || imgRow >= img.height) {
      return false;
    }

    const idx = (imgRow * img.width + imgCol) * 4;
    const r = imageData.data[idx];
    const g = imageData.data[idx + 1];
    const b = imageData.data[idx + 2];
    const brightness = (r + g + b) / 3;
    return brightness < 128;
  }

  /** Check if a position (in table cm) is on white surface */
  isOnWhite(xCm: number, yCm: number): boolean {
    return !this.isOnBlackLine(xCm, yCm);
  }

  /** Convert table coordinates (cm) to canvas coordinates */
  tableToCanvas(
    xCm: number,
    yCm: number,
    canvasWidth: number,
    canvasHeight: number
  ): { x: number; y: number } {
    const config = this._config();
    const scaleX = canvasWidth / config.widthCm;
    const scaleY = canvasHeight / config.heightCm;
    return {
      x: xCm * scaleX,
      y: canvasHeight - yCm * scaleY,
    };
  }

  /** Convert canvas coordinates to table coordinates (cm) */
  canvasToTable(
    canvasX: number,
    canvasY: number,
    canvasWidth: number,
    canvasHeight: number
  ): { xCm: number; yCm: number } {
    const config = this._config();
    const scaleX = config.widthCm / canvasWidth;
    const scaleY = config.heightCm / canvasHeight;
    return {
      xCm: canvasX * scaleX,
      yCm: (canvasHeight - canvasY) * scaleY,
    };
  }

  // --- Map Parsing ---

  private async parseImage(img: HTMLImageElement): Promise<ParsedMapData> {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height);

    const width = img.width;
    const height = img.height;

    const lineSegments = this.extractBlackLines(imageData, width, height);
    const wallSegments = this.extractWallSegments(imageData, width, height);

    return { width, height, lineSegments, wallSegments };
  }

  private isBlack(data: Uint8ClampedArray, x: number, y: number, width: number, height: number): boolean {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const idx = (y * width + x) * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    return r < BLACK_THRESHOLD && g < BLACK_THRESHOLD && b < BLACK_THRESHOLD;
  }

  private isGray(data: Uint8ClampedArray, x: number, y: number, width: number, height: number): boolean {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const idx = (y * width + x) * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    // Check if it's a gray pixel (similar R, G, B values in the gray range)
    const avg = (r + g + b) / 3;
    const maxDiff = Math.max(Math.abs(r - avg), Math.abs(g - avg), Math.abs(b - avg));
    return avg >= GRAY_MIN && avg <= GRAY_MAX && maxDiff < 30;
  }

  private isGrayBoundary(data: Uint8ClampedArray, x: number, y: number, width: number, height: number): boolean {
    if (!this.isGray(data, x, y, width, height)) return false;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return true;
        if (!this.isGray(data, nx, ny, width, height)) return true;
      }
    }

    return false;
  }

  private extractBlackLines(imageData: ImageData, width: number, height: number): LineSegment[] {
    const segments: LineSegment[] = [];
    const visited = new Uint8Array(width * height);
    const data = imageData.data;

    const directions = [
      { dx: 1, dy: 0 },
      { dx: 0, dy: -1 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
    ];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!this.isBlack(data, x, y, width, height)) continue;
        if (visited[y * width + x]) continue;

        for (const dir of directions) {
          const end = this.traceDirection(data, x, y, dir.dx, dir.dy, width, height, visited);
          if (end.x !== x || end.y !== y) {
            const length = Math.sqrt(Math.pow(end.x - x, 2) + Math.pow(end.y - y, 2));
            if (length >= 1.5) {
              segments.push({
                startX: x,
                startY: y,
                endX: end.x,
                endY: end.y,
                isDiagonal: dir.dx !== 0 && dir.dy !== 0,
              });
              this.markLineVisited(visited, x, y, end.x, end.y, width);
            }
          }
        }
        visited[y * width + x] = 1;
      }
    }

    return this.mergeSegments(segments);
  }

  private traceDirection(
    data: Uint8ClampedArray,
    startX: number,
    startY: number,
    dx: number,
    dy: number,
    width: number,
    height: number,
    visited: Uint8Array
  ): { x: number; y: number } {
    let currentX = startX;
    let currentY = startY;
    let nextX = currentX + dx;
    let nextY = currentY + dy;

    while (
      nextX >= 0 &&
      nextX < width &&
      nextY >= 0 &&
      nextY < height &&
      this.isBlack(data, nextX, nextY, width, height)
    ) {
      currentX = nextX;
      currentY = nextY;
      nextX = currentX + dx;
      nextY = currentY + dy;
    }

    return { x: currentX, y: currentY };
  }

  private markLineVisited(
    visited: Uint8Array,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number
  ): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let x = x0;
    let y = y0;

    while (true) {
      visited[y * width + x] = 1;
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
  }

  private mergeSegments(segments: LineSegment[]): LineSegment[] {
    const filtered: LineSegment[] = [];
    const seen = new Set<string>();

    for (const seg of segments) {
      let s = { x: seg.startX, y: seg.startY };
      let e = { x: seg.endX, y: seg.endY };

      if (s.x > e.x || (s.x === e.x && s.y > e.y)) {
        [s, e] = [e, s];
      }

      const key = `${s.x},${s.y}-${e.x},${e.y}`;
      if (!seen.has(key)) {
        seen.add(key);
        filtered.push({
          startX: s.x,
          startY: s.y,
          endX: e.x,
          endY: e.y,
          isDiagonal: seg.isDiagonal,
        });
      }
    }

    return filtered;
  }

  private extractWallSegments(imageData: ImageData, width: number, height: number): WallSegment[] {
    const segments: WallSegment[] = [];
    const visited = new Uint8Array(width * height);
    const data = imageData.data;

    const directions = [
      { dx: 1, dy: 0 },
      { dx: 1, dy: -1 },
      { dx: 0, dy: -1 },
      { dx: -1, dy: -1 },
      { dx: -1, dy: 0 },
      { dx: -1, dy: 1 },
      { dx: 0, dy: 1 },
      { dx: 1, dy: 1 },
    ];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!this.isGrayBoundary(data, x, y, width, height)) continue;
        if (visited[y * width + x]) continue;

        for (const dir of directions) {
          const end = this.traceGrayDirection(data, x, y, dir.dx, dir.dy, width, height, visited);
          if (end.x !== x || end.y !== y) {
            const length = Math.sqrt(Math.pow(end.x - x, 2) + Math.pow(end.y - y, 2));
            if (length >= 2) {
              segments.push({
                startX: x,
                startY: y,
                endX: end.x,
                endY: end.y,
                thickness: 1,
              });
              this.markLineVisited(visited, x, y, end.x, end.y, width);
            }
          }
        }
        visited[y * width + x] = 1;
      }
    }

    return this.mergeWallSegments(segments);
  }

  private traceGrayDirection(
    data: Uint8ClampedArray,
    startX: number,
    startY: number,
    dx: number,
    dy: number,
    width: number,
    height: number,
    visited: Uint8Array
  ): { x: number; y: number } {
    let currentX = startX;
    let currentY = startY;
    const isDiagonal = dx !== 0 && dy !== 0;

    while (true) {
      const nextX = currentX + dx;
      const nextY = currentY + dy;

      if (
        nextX >= 0 &&
        nextX < width &&
        nextY >= 0 &&
        nextY < height &&
        this.isGrayBoundary(data, nextX, nextY, width, height) &&
        !visited[nextY * width + nextX]
      ) {
        currentX = nextX;
        currentY = nextY;
        continue;
      }

      if (isDiagonal) {
        const hx = currentX + dx;
        const hy = currentY;
        const vx = currentX;
        const vy = currentY + dy;

        if (
          hx >= 0 && hx < width && hy >= 0 && hy < height &&
          this.isGrayBoundary(data, hx, hy, width, height) &&
          !visited[hy * width + hx]
        ) {
          currentX = hx;
          currentY = hy;
          continue;
        }

        if (
          vx >= 0 && vx < width && vy >= 0 && vy < height &&
          this.isGrayBoundary(data, vx, vy, width, height) &&
          !visited[vy * width + vx]
        ) {
          currentX = vx;
          currentY = vy;
          continue;
        }
      }

      break;
    }

    return { x: currentX, y: currentY };
  }

  private mergeWallSegments(segments: WallSegment[]): WallSegment[] {
    const filtered: WallSegment[] = [];
    const seen = new Set<string>();

    for (const seg of segments) {
      let s = { x: seg.startX, y: seg.startY };
      let e = { x: seg.endX, y: seg.endY };

      if (s.x > e.x || (s.x === e.x && s.y > e.y)) {
        [s, e] = [e, s];
      }

      const key = `${s.x},${s.y}-${e.x},${e.y}`;
      if (!seen.has(key)) {
        seen.add(key);
        filtered.push({
          startX: s.x,
          startY: s.y,
          endX: e.x,
          endY: e.y,
          thickness: seg.thickness,
        });
      }
    }

    return this.connectNearbyEndpoints(filtered);
  }

  private connectNearbyEndpoints(segments: WallSegment[]): WallSegment[] {
    const MAX_GAP = 5;
    const ALIGN_THRESHOLD = 0.85;
    const result = [...segments];

    const segDirs = segments.map(seg => {
      const dx = seg.endX - seg.startX;
      const dy = seg.endY - seg.startY;
      const len = Math.hypot(dx, dy);
      return len > 0 ? { x: dx / len, y: dy / len } : { x: 0, y: 0 };
    });

    const endpoints: Array<{ x: number; y: number; segIndex: number }> = [];
    segments.forEach((seg, i) => {
      endpoints.push({ x: seg.startX, y: seg.startY, segIndex: i });
      endpoints.push({ x: seg.endX, y: seg.endY, segIndex: i });
    });

    const connected = new Set<string>();

    for (let i = 0; i < endpoints.length; i++) {
      for (let j = i + 1; j < endpoints.length; j++) {
        const p1 = endpoints[i];
        const p2 = endpoints[j];

        if (p1.segIndex === p2.segIndex) continue;

        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const dist = Math.hypot(dx, dy);

        if (dist > 0.5 && dist <= MAX_GAP) {
          const dir = { x: dx / dist, y: dy / dist };
          const dir1 = segDirs[p1.segIndex];
          const dir2 = segDirs[p2.segIndex];
          const align1 = Math.abs(dir.x * dir1.x + dir.y * dir1.y);
          const align2 = Math.abs(dir.x * dir2.x + dir.y * dir2.y);
          if (align1 < ALIGN_THRESHOLD || align2 < ALIGN_THRESHOLD) continue;

          const key = `${Math.min(p1.x, p2.x)},${Math.min(p1.y, p2.y)}-${Math.max(p1.x, p2.x)},${Math.max(p1.y, p2.y)}`;
          if (!connected.has(key)) {
            connected.add(key);
            result.push({
              startX: p1.x,
              startY: p1.y,
              endX: p2.x,
              endY: p2.y,
              thickness: 1,
            });
          }
        }
      }
    }

    return result;
  }
}
