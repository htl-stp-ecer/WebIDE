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
  @ViewChild('gridCanvas') gridCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('previewCanvas') previewCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasContainer') containerRef!: ElementRef<HTMLDivElement>;

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
  private initialLoadDone = false;
  private drawing = false;
  private lastPoint: { x: number; y: number } | null = null;
  private isPanning = false;
  private panStartPos = { x: 0, y: 0 };
  private resizeObserver!: ResizeObserver;

  ngOnInit(): void {
    // Nothing to do here yet
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    this.clearCanvasWithoutMessage();
    this.centerCanvas();

    this.resizeObserver = new ResizeObserver(() => {
      this.renderGrid();
      this.renderPreview();
    });
    this.resizeObserver.observe(this.containerRef.nativeElement);

    // Load saved map from backend after canvas is ready
    this.loadSavedMap();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  // --- Zoom Controls ---

  setZoom(newZoom: number): void {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    this.zoom.set(clamped);
    this.renderGrid();
    this.renderPreview();
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    const oldZoom = this.zoom();
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom + delta));

    if (newZoom === oldZoom) return;

    // Zoom toward mouse position
    const container = this.containerRef.nativeElement;
    const rect = container.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const offset = this.panOffset();
    const zoomRatio = newZoom / oldZoom;

    this.panOffset.set({
      x: mouseX - (mouseX - offset.x) * zoomRatio,
      y: mouseY - (mouseY - offset.y) * zoomRatio,
    });

    this.zoom.set(newZoom);
    this.renderGrid();
    this.renderPreview();
  }

  fitToView(): void {
    const container = this.containerRef.nativeElement;
    const containerWidth = container.clientWidth - 40; // padding
    const containerHeight = container.clientHeight - 40;

    const scaleX = containerWidth / MAP_WIDTH;
    const scaleY = containerHeight / MAP_HEIGHT;
    const newZoom = Math.min(scaleX, scaleY, MAX_ZOOM);

    this.zoom.set(Math.max(MIN_ZOOM, newZoom));
    this.centerCanvas();
    this.renderGrid();
    this.renderPreview();
  }

  private centerCanvas(): void {
    const container = this.containerRef.nativeElement;
    const z = this.zoom();
    const canvasDisplayWidth = MAP_WIDTH * z;
    const canvasDisplayHeight = MAP_HEIGHT * z;

    this.panOffset.set({
      x: (container.clientWidth - canvasDisplayWidth) / 2,
      y: (container.clientHeight - canvasDisplayHeight) / 2,
    });
  }

  // --- Grid ---

  toggleGrid(): void {
    this.showGrid.update(v => !v);
    this.renderGrid();
  }

  private renderGrid(): void {
    if (!this.gridCanvasRef) return;
    const gridCanvas = this.gridCanvasRef.nativeElement;
    const container = this.containerRef.nativeElement;
    const ctx = gridCanvas.getContext('2d')!;

    const dpr = window.devicePixelRatio || 1;
    gridCanvas.width = container.clientWidth * dpr;
    gridCanvas.height = container.clientHeight * dpr;
    gridCanvas.style.width = `${container.clientWidth}px`;
    gridCanvas.style.height = `${container.clientHeight}px`;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, container.clientWidth, container.clientHeight);

    if (!this.showGrid()) return;

    const z = this.zoom();
    const offset = this.panOffset();

    // Only draw grid when zoomed in enough
    if (z < 2) return;

    ctx.strokeStyle = 'rgba(100, 116, 139, 0.4)';
    ctx.lineWidth = 1;

    // Vertical lines
    for (let x = 0; x <= MAP_WIDTH; x++) {
      const screenX = offset.x + x * z;
      if (screenX < 0 || screenX > container.clientWidth) continue;
      ctx.beginPath();
      ctx.moveTo(screenX, Math.max(0, offset.y));
      ctx.lineTo(screenX, Math.min(container.clientHeight, offset.y + MAP_HEIGHT * z));
      ctx.stroke();
    }

    // Horizontal lines
    for (let y = 0; y <= MAP_HEIGHT; y++) {
      const screenY = offset.y + y * z;
      if (screenY < 0 || screenY > container.clientHeight) continue;
      ctx.beginPath();
      ctx.moveTo(Math.max(0, offset.x), screenY);
      ctx.lineTo(Math.min(container.clientWidth, offset.x + MAP_WIDTH * z), screenY);
      ctx.stroke();
    }
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
      x: offset.x + dx,
      y: offset.y + dy,
    }));
    this.renderGrid();
    this.renderPreview();
  }

  private endPan(): void {
    this.isPanning = false;
  }

  // --- Coordinate Transform ---

  private getMapCoords(event: PointerEvent): { x: number; y: number } | null {
    const container = this.containerRef.nativeElement;
    const rect = container.getBoundingClientRect();
    const z = this.zoom();
    const offset = this.panOffset();

    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    const mapX = Math.floor((screenX - offset.x) / z);
    const mapY = Math.floor((screenY - offset.y) / z);

    if (mapX < 0 || mapX >= MAP_WIDTH || mapY < 0 || mapY >= MAP_HEIGHT) {
      return null;
    }

    return { x: mapX, y: mapY };
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
    const container = this.containerRef.nativeElement;
    const ctx = previewCanvas.getContext('2d')!;

    const dpr = window.devicePixelRatio || 1;
    previewCanvas.width = container.clientWidth * dpr;
    previewCanvas.height = container.clientHeight * dpr;
    previewCanvas.style.width = `${container.clientWidth}px`;
    previewCanvas.style.height = `${container.clientHeight}px`;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, container.clientWidth, container.clientHeight);

    if (!this.linePreviewVisible()) return;

    const start = this.lineStartPoint();
    const end = this.lineEndPoint();
    if (!start || !end) return;

    const z = this.zoom();
    const offset = this.panOffset();
    const color = this.selectedColor();

    // Draw preview pixels
    const points = bresenhamLine(start.x, start.y, end.x, end.y);
    ctx.fillStyle = colorToHex(color);

    for (const p of points) {
      const screenX = offset.x + p.x * z;
      const screenY = offset.y + p.y * z;
      ctx.fillRect(screenX, screenY, z, z);
    }

    // Draw semi-transparent overlay
    ctx.globalAlpha = 0.5;
    for (const p of points) {
      const screenX = offset.x + p.x * z;
      const screenY = offset.y + p.y * z;
      ctx.fillRect(screenX, screenY, z, z);
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

  // --- Load Map (save to device) ---

  async loadMap(): Promise<void> {
    const canvas = this.canvasRef.nativeElement;
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];

    try {
      // Save to backend
      await this.http.saveTableMap(base64).toPromise();
      // Also load into the map service
      await this.mapService.loadMapFromBase64(base64);
      this.mapExported.emit(base64);
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
    this.http.getTableMap().subscribe({
      next: (response) => {
        if (response.image) {
          this.loadImageToCanvas(response.image);
        }
      },
      error: () => {
        // Silently ignore if no saved map exists
      },
    });
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
