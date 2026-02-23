import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  OnInit,
  signal,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { TableEditorToolbar } from './table-editor-toolbar';
import { TableMapService } from './services';
import { HttpService } from '../../../services/http-service';
import {
  DrawingTool,
  PaintColor,
  MAP_WIDTH,
  MAP_HEIGHT,
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEP,
  colorToHex,
  bresenhamLine,
} from './models/editor-state';

@Component({
  selector: 'app-table-editor-view',
  standalone: true,
  imports: [CommonModule, TranslateModule, TableEditorToolbar],
  templateUrl: './table-editor-view.html',
  styleUrl: './table-editor-view.scss',
})
export class TableEditorView implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('editorCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('previewCanvas') previewCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasContainer') containerRef!: ElementRef<HTMLDivElement>;

  readonly projectUuid = input<string | null>(null);
  readonly mapExported = output<string>();

  // State signals
  readonly zoom = signal<number>(8);
  readonly panOffset = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly showGrid = signal<boolean>(true);
  readonly activeTool = signal<DrawingTool>('brush');
  readonly selectedColor = signal<PaintColor>('black');
  readonly message = signal<string>('');
  readonly hoverCoords = signal<{ x: number; y: number } | null>(null);

  // Canvas dimensions
  readonly MAP_WIDTH = MAP_WIDTH;
  readonly MAP_HEIGHT = MAP_HEIGHT;
  readonly PREVIEW_SCALE = 16;

  // Computed canvas transform
  readonly canvasTransform = computed(() => {
    const z = this.zoom();
    const offset = this.panOffset();
    return `translate(${offset.x}px, ${offset.y}px) scale(${z})`;
  });

  // Line tool state
  readonly lineStartPoint = signal<{ x: number; y: number } | null>(null);
  readonly lineEndPoint = signal<{ x: number; y: number } | null>(null);
  readonly linePreviewVisible = computed(() =>
    this.activeTool() === 'line' && this.lineStartPoint() !== null
  );

  private readonly mapService = inject(TableMapService);
  private readonly translate = inject(TranslateService);
  private readonly http = inject(HttpService);

  private ctx!: CanvasRenderingContext2D;
  private drawing = false;
  private lastPoint: { x: number; y: number } | null = null;
  private isPanning = false;
  private panStartPos = { x: 0, y: 0 };
  private resizeObserver!: ResizeObserver;
  private overlayRenderFrame: number | null = null;

  ngOnInit(): void {
    // Nothing to do here yet
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    this.clearCanvasWithoutMessage();
    this.centerCanvas();

    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleOverlayRender();
    });
    this.resizeObserver.observe(this.containerRef.nativeElement);
    this.scheduleOverlayRender();

    // Load saved map from backend after canvas is ready
    this.loadSavedMap();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    if (this.overlayRenderFrame !== null) {
      cancelAnimationFrame(this.overlayRenderFrame);
      this.overlayRenderFrame = null;
    }
  }

  // --- Zoom Controls ---

  setZoom(newZoom: number): void {
    const clamped = this.resolveZoomRequest(newZoom);
    this.zoom.set(clamped);
    this.scheduleOverlayRender();
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    const oldZoom = this.zoom();
    const newZoom = this.resolveZoomRequest(oldZoom + delta);

    if (newZoom === oldZoom) return;

    // Zoom toward mouse position
    const container = this.containerRef.nativeElement;
    const rect = container.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const offset = this.panOffset();
    const zoomRatio = newZoom / oldZoom;

    const nextOffset = {
      x: Math.round(mouseX - (mouseX - offset.x) * zoomRatio),
      y: Math.round(mouseY - (mouseY - offset.y) * zoomRatio),
    };

    this.zoom.set(newZoom);
    this.panOffset.set(nextOffset);
    this.scheduleOverlayRender();
  }

  fitToView(): void {
    const container = this.containerRef.nativeElement;
    const containerWidth = container.clientWidth - 40; // padding
    const containerHeight = container.clientHeight - 40;

    const scaleX = containerWidth / MAP_WIDTH;
    const scaleY = containerHeight / MAP_HEIGHT;
    const newZoom = Math.min(scaleX, scaleY, MAX_ZOOM);

    this.zoom.set(this.snapZoomToDevicePixels(newZoom, 'floor'));
    this.centerCanvas();
    this.scheduleOverlayRender();
  }

  /**
   * Align zoom to steps that map one source pixel to an integer count of physical pixels.
   * This prevents cumulative drift between pixel-art rendering and overlay grid lines.
   */
  private snapZoomToDevicePixels(zoom: number, mode: 'nearest' | 'floor' = 'nearest'): number {
    const dpr = window.devicePixelRatio || 1;
    const step = 1 / dpr;
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    const stepped = mode === 'floor'
      ? Math.floor(clamped / step) * step
      : Math.round(clamped / step) * step;
    return Math.max(MIN_ZOOM, stepped);
  }

  /**
   * Ensure interactive zoom changes always move at least one snapped step,
   * otherwise +/- or wheel can appear "stuck" after snapping.
   */
  private resolveZoomRequest(requestedZoom: number): number {
    const currentZoom = this.zoom();
    let snapped = this.snapZoomToDevicePixels(requestedZoom, 'nearest');

    if (snapped === currentZoom && requestedZoom !== currentZoom) {
      const step = 1 / (window.devicePixelRatio || 1);
      const direction = requestedZoom > currentZoom ? 1 : -1;
      snapped = this.snapZoomToDevicePixels(currentZoom + direction * step, 'nearest');
    }

    return snapped;
  }

  private centerCanvas(): void {
    const container = this.containerRef.nativeElement;
    const z = this.zoom();
    const canvasDisplayWidth = MAP_WIDTH * z;
    const canvasDisplayHeight = MAP_HEIGHT * z;

    this.panOffset.set({
      x: Math.round((container.clientWidth - canvasDisplayWidth) / 2),
      y: Math.round((container.clientHeight - canvasDisplayHeight) / 2),
    });
  }

  private scheduleOverlayRender(): void {
    if (this.overlayRenderFrame !== null) return;
    this.overlayRenderFrame = requestAnimationFrame(() => {
      this.overlayRenderFrame = null;
      this.renderPreview();
    });
  }

  // --- Grid ---

  toggleGrid(): void {
    this.showGrid.update(v => !v);
    this.scheduleOverlayRender();
  }

  // --- Tool Handling ---

  setTool(tool: DrawingTool): void {
    this.activeTool.set(tool);
    this.lineStartPoint.set(null);
    this.lineEndPoint.set(null);
    this.renderPreview();
  }

  setColor(color: PaintColor): void {
    this.selectedColor.set(color);
  }

  // --- Pointer Events ---

  onPointerDown(event: PointerEvent): void {
    // Middle click or space+click for panning
    if (event.button === 1) {
      this.startPan(event);
      return;
    }

    if (event.button !== 0) return;

    const coords = this.getMapCoords(event);
    if (!coords) return;

    const tool = this.activeTool();

    if (tool === 'line') {
      this.lineStartPoint.set(coords);
      this.lineEndPoint.set(coords);
    } else {
      this.drawing = true;
      this.lastPoint = coords;
      this.paintPixel(coords.x, coords.y);
    }
  }

  onPointerMove(event: PointerEvent): void {
    // Update hover coordinates
    const coords = this.getMapCoords(event);
    this.hoverCoords.set(coords);

    if (this.isPanning) {
      this.updatePan(event);
      return;
    }

    if (!coords) return;

    const tool = this.activeTool();

    if (tool === 'line' && this.lineStartPoint()) {
      this.lineEndPoint.set(coords);
      this.renderPreview();
    } else if (this.drawing && this.lastPoint) {
      // Draw line from last point to current for smooth strokes
      const points = bresenhamLine(this.lastPoint.x, this.lastPoint.y, coords.x, coords.y);
      for (const p of points) {
        this.paintPixel(p.x, p.y);
      }
      this.lastPoint = coords;
    }
  }

  onPointerUp(event: PointerEvent): void {
    if (this.isPanning) {
      this.endPan();
      return;
    }

    const tool = this.activeTool();

    if (tool === 'line' && this.lineStartPoint()) {
      const coords = this.getMapCoords(event);
      if (coords) {
        const start = this.lineStartPoint()!;
        const points = bresenhamLine(start.x, start.y, coords.x, coords.y);
        for (const p of points) {
          this.paintPixel(p.x, p.y);
        }
      }
      this.lineStartPoint.set(null);
      this.lineEndPoint.set(null);
      this.renderPreview();
    } else {
      this.drawing = false;
      this.lastPoint = null;
    }
  }

  onPointerLeave(): void {
    this.hoverCoords.set(null);
    if (!this.activeTool() || this.activeTool() !== 'line') {
      this.drawing = false;
      this.lastPoint = null;
    }
    if (this.isPanning) {
      this.endPan();
    }
  }

  // --- Panning ---

  private startPan(event: PointerEvent): void {
    this.isPanning = true;
    this.panStartPos = { x: event.clientX, y: event.clientY };
  }

  private updatePan(event: PointerEvent): void {
    const dx = event.clientX - this.panStartPos.x;
    const dy = event.clientY - this.panStartPos.y;
    this.panStartPos = { x: event.clientX, y: event.clientY };

    this.panOffset.update(offset => ({
      x: Math.round(offset.x + dx),
      y: Math.round(offset.y + dy),
    }));
    this.scheduleOverlayRender();
  }

  private endPan(): void {
    this.isPanning = false;
  }

  // --- Coordinate Transform ---

  private getMapCoords(event: PointerEvent): { x: number; y: number } | null {
    if (!this.canvasRef || !this.containerRef) return null;

    const canvasRect = this.canvasRef.nativeElement.getBoundingClientRect();
    if (canvasRect.width <= 0 || canvasRect.height <= 0) return null;
    const localX = event.clientX - canvasRect.left;
    const localY = event.clientY - canvasRect.top;

    if (localX < 0 || localY < 0 || localX >= canvasRect.width || localY >= canvasRect.height) {
      return null;
    }

    const dpr = window.devicePixelRatio || 1;
    const mapWidthDev = Math.max(1, Math.round(canvasRect.width * dpr));
    const mapHeightDev = Math.max(1, Math.round(canvasRect.height * dpr));
    const xEdgesDev = this.buildRasterEdges(mapWidthDev, MAP_WIDTH);
    const yEdgesDev = this.buildRasterEdges(mapHeightDev, MAP_HEIGHT);

    const localDevX = Math.min(
      mapWidthDev - 1,
      Math.max(0, Math.floor((localX / canvasRect.width) * mapWidthDev))
    );
    const localDevY = Math.min(
      mapHeightDev - 1,
      Math.max(0, Math.floor((localY / canvasRect.height) * mapHeightDev))
    );

    const mapX = this.findCellIndex(localDevX, xEdgesDev);
    const mapY = this.findCellIndex(localDevY, yEdgesDev);

    if (mapX < 0 || mapX >= MAP_WIDTH || mapY < 0 || mapY >= MAP_HEIGHT) {
      return null;
    }

    return { x: mapX, y: mapY };
  }

  private buildRasterEdges(totalDev: number, cells: number): number[] {
    const edges = new Array<number>(cells + 1);
    for (let i = 0; i <= cells; i++) {
      edges[i] = Math.round((i * totalDev) / cells);
    }
    return edges;
  }

  private findCellIndex(valueDev: number, edges: number[]): number {
    let lo = 0;
    let hi = edges.length - 2;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (valueDev < edges[mid]) {
        hi = mid - 1;
      } else if (valueDev >= edges[mid + 1]) {
        lo = mid + 1;
      } else {
        return mid;
      }
    }

    return Math.max(0, Math.min(edges.length - 2, lo));
  }

  // --- Drawing ---

  private paintPixel(x: number, y: number): void {
    const tool = this.activeTool();
    const color = tool === 'eraser' ? 'white' : this.selectedColor();
    this.ctx.fillStyle = colorToHex(color);
    this.ctx.fillRect(x, y, 1, 1);
  }

  clearCanvas(): void {
    this.clearCanvasWithoutMessage();
    this.message.set(this.translate.instant('FLOWCHART.TABLE_MESSAGE_CLEARED'));
  }

  private clearCanvasWithoutMessage(): void {
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
  }

  // --- Line Preview ---

  private renderPreview(): void {
    if (!this.previewCanvasRef) return;
    const previewCanvas = this.previewCanvasRef.nativeElement;
    const ctx = previewCanvas.getContext('2d')!;
    const scale = this.PREVIEW_SCALE;
    const previewWidth = MAP_WIDTH * scale;
    const previewHeight = MAP_HEIGHT * scale;

    ctx.clearRect(0, 0, previewWidth, previewHeight);

    if (this.showGrid() && this.zoom() >= 2) {
      const lineWidth = scale / this.zoom();
      ctx.fillStyle = 'rgba(100, 116, 139, 0.5)';
      for (let x = 0; x <= MAP_WIDTH; x++) {
        const gx = x * scale;
        ctx.fillRect(gx - lineWidth / 2, 0, lineWidth, previewHeight);
      }
      for (let y = 0; y <= MAP_HEIGHT; y++) {
        const gy = y * scale;
        ctx.fillRect(0, gy - lineWidth / 2, previewWidth, lineWidth);
      }
    }

    if (!this.linePreviewVisible()) return;

    const start = this.lineStartPoint();
    const end = this.lineEndPoint();
    if (!start || !end) return;

    const color = this.selectedColor();

    // Draw preview pixels
    const points = bresenhamLine(start.x, start.y, end.x, end.y);
    ctx.fillStyle = colorToHex(color);

    for (const p of points) {
      ctx.fillRect(p.x * scale, p.y * scale, scale, scale);
    }

    // Draw semi-transparent overlay
    ctx.globalAlpha = 0.5;
    for (const p of points) {
      ctx.fillRect(p.x * scale, p.y * scale, scale, scale);
    }
    ctx.globalAlpha = 1;
  }

  // --- PNG Upload ---

  async uploadPng(): Promise<void> {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png';

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      try {
        const img = await this.loadImage(file);

        if (img.width !== MAP_WIDTH || img.height !== MAP_HEIGHT) {
          this.message.set(
            this.translate.instant('FLOWCHART.TABLE_UPLOAD_INVALID_SIZE', {
              expected: `${MAP_WIDTH}x${MAP_HEIGHT}`,
              actual: `${img.width}x${img.height}`,
            })
          );
          return;
        }

        // Draw to canvas
        this.ctx.drawImage(img, 0, 0);
        this.message.set(this.translate.instant('FLOWCHART.TABLE_UPLOAD_SUCCESS'));
      } catch (err) {
        this.message.set(
          this.translate.instant('FLOWCHART.TABLE_UPLOAD_FAILED', {
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    };

    input.click();
  }

  private loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = reader.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // --- Load Map (apply + persist) ---

  async loadMap(): Promise<void> {
    const canvas = this.canvasRef.nativeElement;
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];

    try {
      // Always load into map service first so the UI updates even if backend save fails.
      await this.mapService.loadMapFromBase64(base64);
      this.mapExported.emit(base64);
    } catch (err) {
      this.message.set(
        this.translate.instant('FLOWCHART.TABLE_MESSAGE_FAILED', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
      return;
    }

    try {
      const projectUuid = this.projectUuid();
      if (projectUuid) {
        await this.http.saveLocalTableMap(projectUuid, base64).toPromise();
      } else {
        await this.http.saveTableMap(base64).toPromise();
      }
      this.message.set(
        this.translate.instant('FLOWCHART.TABLE_MESSAGE_SAVED', {
          width: MAP_WIDTH,
          height: MAP_HEIGHT,
        })
      );
    } catch (err) {
      this.message.set(
        this.translate.instant('FLOWCHART.TABLE_MESSAGE_FAILED', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  // --- Load saved map from backend ---

  private loadSavedMap(): void {
    const projectUuid = this.projectUuid();
    try {
      const request$ = projectUuid
        ? this.http.getLocalTableMap(projectUuid)
        : this.http.getTableMap();

      request$.subscribe({
        next: (response) => {
          if (response.image) {
            this.loadImageToCanvas(response.image);
          }
        },
        error: () => {
          // Silently ignore if no saved map exists
        },
      });
    } catch {
      // No device base configured in remote mode; silently skip.
    }
  }

  private loadImageToCanvas(base64: string): void {
    const img = new Image();
    img.onload = () => {
      if (this.ctx && img.width === MAP_WIDTH && img.height === MAP_HEIGHT) {
        this.ctx.drawImage(img, 0, 0);
        // Also load into map service
        this.mapService.loadMapFromBase64(base64);
        this.message.set(
          this.translate.instant('FLOWCHART.TABLE_MESSAGE_LOADED', {
            width: MAP_WIDTH,
            height: MAP_HEIGHT,
          })
        );
      }
    };
    img.src = `data:image/png;base64,${base64}`;
  }
}
