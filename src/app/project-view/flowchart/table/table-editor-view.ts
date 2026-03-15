import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { TableEditorToolbar } from './table-editor-toolbar';
import { TableMapService, type LineSegmentCm, type WallSegmentCm } from './services';
import { HttpService } from '../../../services/http-service';
import {
  CoordOrigin,
  EditorTool,
  GuideLine,
  LineKind,
  MAP_HEIGHT,
  MAP_WIDTH,
  MAX_ZOOM,
  MeasurementUnit,
  MIN_ZOOM,
  MIN_LINE_WIDTH_CM,
  DEFAULT_LINE_WIDTH_CM,
  DEFAULT_WALL_WIDTH_CM,
  TABLE_HEIGHT_CM,
  TABLE_WIDTH_CM,
  VectorLine,
  VectorPoint,
  ZOOM_STEP,
  clampToTable,
  convertFromCm,
  convertToCm,
  formatDistance,
  lineLengthCm,
  pointToSegmentDistanceCm,
  roundTo,
  CM_PER_PIXEL_X,
  CM_PER_PIXEL_Y,
} from './models/editor-state';

type EndpointHandle = 'start' | 'end';

type SelectDragState =
  | {
      mode: 'line';
      lineId: string;
      startPointer: VectorPoint;
      originStart: VectorPoint;
      originEnd: VectorPoint;
    }
  | {
      mode: 'endpoint';
      lineId: string;
      endpoint: EndpointHandle;
      anchor: VectorPoint;
    };

const TABLE_MAP_FILE_FORMAT = 'flowchart-table-map';
const TABLE_MAP_FILE_VERSION = 1;
const TABLE_MAP_FILE_EXTENSION = 'ftmap';

interface TableMapFileLine {
  kind: LineKind;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  widthCm: number;
}

interface TableMapFileV1 {
  format: typeof TABLE_MAP_FILE_FORMAT;
  version: typeof TABLE_MAP_FILE_VERSION;
  table: {
    widthCm: number;
    heightCm: number;
  };
  lines: TableMapFileLine[];
}

@Component({
  selector: 'app-table-editor-view',
  standalone: true,
  imports: [CommonModule, TranslateModule, TableEditorToolbar],
  templateUrl: './table-editor-view.html',
  styleUrl: './table-editor-view.scss',
})
export class TableEditorView implements AfterViewInit, OnDestroy {
  @ViewChild('canvasContainer') containerRef!: ElementRef<HTMLDivElement>;

  readonly projectUuid = input<string | null>(null);
  readonly mapExported = output<string>();

  readonly TABLE_WIDTH_CM = TABLE_WIDTH_CM;
  readonly TABLE_HEIGHT_CM = TABLE_HEIGHT_CM;

  readonly zoom = signal<number>(4);
  readonly panOffset = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly showGrid = signal<boolean>(true);
  readonly showSmartGuides = signal<boolean>(true);
  readonly activeTool = signal<EditorTool>('draw');
  readonly lineKind = signal<LineKind>('line');
  readonly measurementUnit = signal<MeasurementUnit>('cm');
  readonly message = signal<string>('');
  readonly hoverCoords = signal<VectorPoint | null>(null);

  readonly lines = signal<VectorLine[]>([]);
  readonly selectedLineId = signal<string | null>(null);
  readonly lengthInputValue = signal<string>('');
  readonly widthInputValue = signal<string>('');
  readonly startXInputValue = signal<string>('');
  readonly startYInputValue = signal<string>('');
  readonly endXInputValue = signal<string>('');
  readonly endYInputValue = signal<string>('');

  /** Which table corner the X/Y coordinate inputs measure from. */
  readonly coordOrigin = signal<CoordOrigin>('tl');

  /** Measurement tool state: two picked anchor points. */
  readonly measurePointA = signal<VectorPoint | null>(null);
  readonly measurePointB = signal<VectorPoint | null>(null);
  readonly measurement = computed(() => {
    const a = this.measurePointA();
    const b = this.measurePointB();
    if (!a || !b) return null;
    return {
      a, b,
      dx: Math.abs(b.x - a.x),
      dy: Math.abs(b.y - a.y),
      direct: Math.hypot(b.x - a.x, b.y - a.y),
    };
  });

  readonly draftStart = signal<VectorPoint | null>(null);
  readonly draftEnd = signal<VectorPoint | null>(null);
  readonly guideLines = signal<GuideLine[]>([]);

  readonly selectedLine = computed(() => {
    const id = this.selectedLineId();
    if (!id) return null;
    return this.lines().find(line => line.id === id) ?? null;
  });

  readonly canvasTransform = computed(() => {
    const z = this.zoom();
    const offset = this.panOffset();
    return `translate(${offset.x}px, ${offset.y}px) scale(${z})`;
  });

  readonly selectedEditorPosition = computed(() => {
    const line = this.selectedLine();
    if (!line) return null;
    this.viewportVersion();

    const midpoint = this.lineMidpoint(line);
    const zoom = this.zoom();
    const offset = this.panOffset();
    const midpointPx = {
      x: offset.x + midpoint.x * zoom,
      y: offset.y + midpoint.y * zoom,
    };

    const dx = line.endX - line.startX;
    const dy = line.endY - line.startY;
    const length = Math.hypot(dx, dy);

    let nx = 0;
    let ny = -1;
    if (length > 0.0001) {
      nx = -dy / length;
      ny = dx / length;
    }

    const panelWidthPx = 250;
    const panelHeightPx = 250;
    const desiredGapPx = 24;
    // Rectangle support distance in direction (nx, ny): guarantees fixed edge gap for any angle.
    const directionalHalfExtentPx = Math.abs(nx) * (panelWidthPx * 0.5) + Math.abs(ny) * (panelHeightPx * 0.5);
    const popupOffsetPx = directionalHalfExtentPx + desiredGapPx;
    const candidateA = {
      x: midpointPx.x + nx * popupOffsetPx,
      y: midpointPx.y + ny * popupOffsetPx,
    };
    const candidateB = {
      x: midpointPx.x - nx * popupOffsetPx,
      y: midpointPx.y - ny * popupOffsetPx,
    };

    const container = this.containerRef?.nativeElement;
    if (!container) {
      return midpointPx;
    }

    const marginPx = 12;
    const maxX = container.clientWidth - marginPx - panelWidthPx * 0.5;
    const maxY = container.clientHeight - marginPx - panelHeightPx * 0.5;
    const minX = marginPx + panelWidthPx * 0.5;
    const minY = marginPx + panelHeightPx * 0.5;

    const scoreCandidate = (candidate: { x: number; y: number }): number => {
      const left = candidate.x - panelWidthPx * 0.5 - marginPx;
      const top = candidate.y - panelHeightPx * 0.5 - marginPx;
      const right = container.clientWidth - marginPx - (candidate.x + panelWidthPx * 0.5);
      const bottom = container.clientHeight - marginPx - (candidate.y + panelHeightPx * 0.5);
      return Math.min(left, top, right, bottom);
    };

    const chosen = scoreCandidate(candidateA) >= scoreCandidate(candidateB) ? candidateA : candidateB;

    return {
      x: Math.max(minX, Math.min(maxX, chosen.x)),
      y: Math.max(minY, Math.min(maxY, chosen.y)),
    };
  });

  readonly draftLengthLabel = computed(() => {
    const start = this.draftStart();
    const end = this.draftEnd();
    if (!start || !end) return null;

    const length = lineLengthCm({
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y,
    });

    return formatDistance(length, this.measurementUnit());
  });

  readonly gridX = Array.from({ length: Math.floor(TABLE_WIDTH_CM / 5) + 1 }, (_, idx) => idx * 5);
  readonly gridY = Array.from({ length: Math.floor(TABLE_HEIGHT_CM / 5) + 1 }, (_, idx) => idx * 5);

  private readonly mapService = inject(TableMapService);
  private readonly translate = inject(TranslateService);
  private readonly http = inject(HttpService);

  private resizeObserver?: ResizeObserver;
  private readonly viewportVersion = signal(0);
  private isPanning = false;
  private panStartPos = { x: 0, y: 0 };
  private selectDragState: SelectDragState | null = null;

  private readonly createLineThresholdCm = 0.4;
  private readonly selectThresholdCm = 1.6;
  private readonly endpointHandleHitThresholdCm = 1.8;
  private readonly endpointSnapThresholdCm = 1.4;
  private readonly alignmentSnapThresholdCm = 1;
  private readonly angleSnapThresholdRad = Math.PI / 36;

  constructor() {
    effect(() => {
      const selected = this.selectedLine();
      const unit = this.measurementUnit();
      const origin = this.coordOrigin();
      if (!selected) {
        this.lengthInputValue.set('');
        this.widthInputValue.set('');
        this.startXInputValue.set('');
        this.startYInputValue.set('');
        this.endXInputValue.set('');
        this.endYInputValue.set('');
        return;
      }

      const value = convertFromCm(lineLengthCm(selected), unit);
      this.lengthInputValue.set(`${roundTo(value, 2)}`);
      const width = convertFromCm(selected.widthCm, unit);
      this.widthInputValue.set(`${roundTo(width, 2)}`);
      this.startXInputValue.set(`${roundTo(convertFromCm(this.toDisplayX(selected.startX, origin), unit), 2)}`);
      this.startYInputValue.set(`${roundTo(convertFromCm(this.toDisplayY(selected.startY, origin), unit), 2)}`);
      this.endXInputValue.set(`${roundTo(convertFromCm(this.toDisplayX(selected.endX, origin), unit), 2)}`);
      this.endYInputValue.set(`${roundTo(convertFromCm(this.toDisplayY(selected.endY, origin), unit), 2)}`);
    });
  }

  /** Convert absolute X to display value based on chosen origin corner. */
  private toDisplayX(absX: number, origin: CoordOrigin): number {
    return origin === 'tr' || origin === 'br' ? TABLE_WIDTH_CM - absX : absX;
  }
  /** Convert absolute Y to display value based on chosen origin corner. */
  private toDisplayY(absY: number, origin: CoordOrigin): number {
    return origin === 'bl' || origin === 'br' ? TABLE_HEIGHT_CM - absY : absY;
  }
  /** Convert display X back to absolute. */
  private fromDisplayX(displayX: number, origin: CoordOrigin): number {
    return origin === 'tr' || origin === 'br' ? TABLE_WIDTH_CM - displayX : displayX;
  }
  /** Convert display Y back to absolute. */
  private fromDisplayY(displayY: number, origin: CoordOrigin): number {
    return origin === 'bl' || origin === 'br' ? TABLE_HEIGHT_CM - displayY : displayY;
  }

  ngAfterViewInit(): void {
    this.centerCanvas();

    this.resizeObserver = new ResizeObserver(() => {
      // Keep current pan/zoom; only ensure map remains visible after strong container changes.
      const point = this.panOffset();
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        this.centerCanvas();
      }
      this.viewportVersion.update(v => v + 1);
    });
    this.resizeObserver.observe(this.containerRef.nativeElement);

    this.loadSavedMap();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  @HostListener('window:keydown', ['$event'])
  onWindowKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.activeTool() === 'measure') {
      this.measurePointA.set(null);
      this.measurePointB.set(null);
      this.activeTool.set('draw');
      return;
    }

    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const activeElement = document.activeElement;
    if (activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName)) return;

    if (this.selectedLine()) {
      event.preventDefault();
      this.deleteSelectedLine();
    }
  }

  setZoom(newZoom: number): void {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    this.zoom.set(Number(clamped.toFixed(4)));
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();

    const oldZoom = this.zoom();
    const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    const newZoom = Number(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom + delta)).toFixed(4));
    if (newZoom === oldZoom) return;

    const rect = this.containerRef.nativeElement.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const pan = this.panOffset();
    const zoomRatio = newZoom / oldZoom;

    this.panOffset.set({
      x: mouseX - (mouseX - pan.x) * zoomRatio,
      y: mouseY - (mouseY - pan.y) * zoomRatio,
    });
    this.zoom.set(newZoom);
  }

  fitToView(): void {
    const container = this.containerRef.nativeElement;
    const availableWidth = Math.max(40, container.clientWidth - 40);
    const availableHeight = Math.max(40, container.clientHeight - 40);

    const scaleX = availableWidth / TABLE_WIDTH_CM;
    const scaleY = availableHeight / TABLE_HEIGHT_CM;
    this.zoom.set(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(scaleX, scaleY))));
    this.centerCanvas();
  }

  private centerCanvas(): void {
    const container = this.containerRef?.nativeElement;
    if (!container) return;

    const z = this.zoom();
    const width = TABLE_WIDTH_CM * z;
    const height = TABLE_HEIGHT_CM * z;

    this.panOffset.set({
      x: (container.clientWidth - width) / 2,
      y: (container.clientHeight - height) / 2,
    });
  }

  toggleGrid(): void {
    this.showGrid.update(value => !value);
  }

  toggleSmartGuides(): void {
    this.showSmartGuides.update(value => !value);
  }

  setTool(tool: EditorTool): void {
    this.activeTool.set(tool);
    this.selectDragState = null;
    this.guideLines.set([]);
    this.clearDraft();
    if (tool !== 'measure') {
      this.measurePointA.set(null);
      this.measurePointB.set(null);
    }
  }

  private handleMeasureClick(point: VectorPoint): void {
    // Snap to nearest anchor point
    const snapped = this.findNearestAnchor(point, this.endpointSnapThresholdCm * 2) ?? point;
    const picked = { x: roundTo(snapped.x, 2), y: roundTo(snapped.y, 2) };

    if (!this.measurePointA() || this.measurePointB()) {
      // Start new measurement (or reset after both were set)
      this.measurePointA.set(picked);
      this.measurePointB.set(null);
    } else {
      // Set second point
      this.measurePointB.set(picked);
    }
  }

  setLineKind(kind: LineKind): void {
    this.lineKind.set(kind);
  }

  setMeasurementUnit(unit: MeasurementUnit): void {
    this.measurementUnit.set(unit);
  }

  onPointerDown(event: PointerEvent): void {
    if (event.button === 1) {
      event.preventDefault();
      this.startPan(event);
      return;
    }

    if (event.button !== 0) return;

    const container = this.containerRef.nativeElement;
    container.setPointerCapture(event.pointerId);

    const point = this.getMapCoords(event);
    if (!point) return;

    if (this.activeTool() === 'measure') {
      this.handleMeasureClick(point);
      return;
    }

    if (this.activeTool() === 'select') {
      this.startSelectionInteraction(point);
      return;
    }

    const start = this.snapStartPoint(point);
    this.selectedLineId.set(null);
    this.draftStart.set(start);
    this.draftEnd.set(start);
    this.guideLines.set([]);
  }

  onPointerMove(event: PointerEvent): void {
    const hoverPoint = this.getMapCoords(event);
    this.hoverCoords.set(hoverPoint);

    if (this.isPanning) {
      this.updatePan(event);
      return;
    }

    if (this.selectDragState) {
      const point = this.getMapCoordsClamped(event);
      this.updateSelectDrag(point);
      return;
    }

    const start = this.draftStart();
    if (!start || !hoverPoint) return;

    const snapped = this.applySmartGuides(hoverPoint, start);
    this.draftEnd.set(snapped.point);
    this.guideLines.set(snapped.guides);
  }

  onPointerUp(event: PointerEvent): void {
    const container = this.containerRef?.nativeElement;
    if (container?.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }

    if (this.isPanning) {
      this.endPan();
      return;
    }

    if (this.selectDragState) {
      this.selectDragState = null;
      this.guideLines.set([]);
      return;
    }

    const start = this.draftStart();
    const end = this.draftEnd();
    if (!start || !end) return;

    const newLine: VectorLine = {
      id: this.createLineId(),
      startX: roundTo(start.x, 2),
      startY: roundTo(start.y, 2),
      endX: roundTo(end.x, 2),
      endY: roundTo(end.y, 2),
      kind: this.lineKind(),
      widthCm: this.defaultWidthForKind(this.lineKind()),
    };

    if (lineLengthCm(newLine) >= this.createLineThresholdCm) {
      this.lines.update(lines => [...lines, newLine]);
      this.selectedLineId.set(newLine.id);
    }

    this.clearDraft();
  }

  onPointerLeave(): void {
    this.hoverCoords.set(null);
    if (this.isPanning) {
      this.endPan();
    }
    if (this.selectDragState) {
      this.selectDragState = null;
      this.guideLines.set([]);
    }
  }

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
  }

  private endPan(): void {
    this.isPanning = false;
  }

  private clearDraft(): void {
    this.draftStart.set(null);
    this.draftEnd.set(null);
    this.guideLines.set([]);
  }

  private getMapCoords(event: PointerEvent): VectorPoint | null {
    if (!this.containerRef) return null;

    const rect = this.containerRef.nativeElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const pan = this.panOffset();
    const zoom = this.zoom();

    const x = (event.clientX - rect.left - pan.x) / zoom;
    const y = (event.clientY - rect.top - pan.y) / zoom;

    if (x < 0 || y < 0 || x > TABLE_WIDTH_CM || y > TABLE_HEIGHT_CM) {
      return null;
    }

    return {
      x: roundTo(x, 2),
      y: roundTo(y, 2),
    };
  }

  private getMapCoordsClamped(event: PointerEvent): VectorPoint {
    const rect = this.containerRef.nativeElement.getBoundingClientRect();
    const pan = this.panOffset();
    const zoom = this.zoom();

    const x = (event.clientX - rect.left - pan.x) / zoom;
    const y = (event.clientY - rect.top - pan.y) / zoom;

    return {
      x: roundTo(Math.max(0, Math.min(TABLE_WIDTH_CM, x)), 2),
      y: roundTo(Math.max(0, Math.min(TABLE_HEIGHT_CM, y)), 2),
    };
  }

  private createLineId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `line-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
  }

  private snapStartPoint(point: VectorPoint): VectorPoint {
    const nearest = this.findNearestAnchor(point, this.endpointSnapThresholdCm);
    return nearest ?? point;
  }

  private applySmartGuides(
    point: VectorPoint,
    start: VectorPoint,
    excludeLineId?: string
  ): { point: VectorPoint; guides: GuideLine[] } {
    if (!this.showSmartGuides()) {
      return { point: clampToTable(point), guides: [] };
    }

    const guides: GuideLine[] = [];
    const anchors = this.getAnchorPoints(excludeLineId);
    let snapped = { ...point };

    const xCandidates = [start.x, ...anchors.map(anchor => anchor.x)];
    const yCandidates = [start.y, ...anchors.map(anchor => anchor.y)];

    const snapX = this.findClosestAxis(snapped.x, xCandidates, this.alignmentSnapThresholdCm);
    if (snapX !== null) {
      snapped.x = snapX;
      guides.push({ x1: snapX, y1: 0, x2: snapX, y2: TABLE_HEIGHT_CM, kind: 'alignment' });
    }

    const snapY = this.findClosestAxis(snapped.y, yCandidates, this.alignmentSnapThresholdCm);
    if (snapY !== null) {
      snapped.y = snapY;
      guides.push({ x1: 0, y1: snapY, x2: TABLE_WIDTH_CM, y2: snapY, kind: 'alignment' });
    }

    const dx = snapped.x - start.x;
    const dy = snapped.y - start.y;
    const length = Math.hypot(dx, dy);

    if (length > 0.001) {
      const angle = Math.atan2(dy, dx);
      const step = Math.PI / 4;
      const snappedAngle = Math.round(angle / step) * step;
      const angleDelta = this.angleDelta(angle, snappedAngle);

      if (angleDelta <= this.angleSnapThresholdRad) {
        snapped = clampToTable({
          x: start.x + Math.cos(snappedAngle) * length,
          y: start.y + Math.sin(snappedAngle) * length,
        });
        guides.push({ x1: start.x, y1: start.y, x2: snapped.x, y2: snapped.y, kind: 'angle' });
      }
    }

    const endpoint = this.findNearestAnchor(snapped, this.endpointSnapThresholdCm, excludeLineId);
    if (endpoint) {
      snapped = endpoint;
      guides.push({ x1: start.x, y1: start.y, x2: endpoint.x, y2: endpoint.y, kind: 'endpoint' });
    }

    return {
      point: {
        x: roundTo(snapped.x, 2),
        y: roundTo(snapped.y, 2),
      },
      guides,
    };
  }

  private angleDelta(a: number, b: number): number {
    let delta = Math.abs(a - b);
    while (delta > Math.PI) {
      delta = Math.abs(delta - Math.PI * 2);
    }
    return delta;
  }

  private getAnchorPoints(excludeLineId?: string): VectorPoint[] {
    const anchors: VectorPoint[] = [];
    for (const line of this.lines()) {
      if (excludeLineId && line.id === excludeLineId) continue;
      anchors.push({ x: line.startX, y: line.startY });
      anchors.push({ x: line.endX, y: line.endY });
      anchors.push(this.lineMidpoint(line));
    }
    return anchors;
  }

  private findNearestAnchor(point: VectorPoint, thresholdCm: number, excludeLineId?: string): VectorPoint | null {
    let nearest: VectorPoint | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const anchor of this.getAnchorPoints(excludeLineId)) {
      const distance = Math.hypot(anchor.x - point.x, anchor.y - point.y);
      if (distance <= thresholdCm && distance < nearestDistance) {
        nearest = anchor;
        nearestDistance = distance;
      }
    }

    return nearest;
  }

  private findClosestAxis(value: number, candidates: number[], thresholdCm: number): number | null {
    let best: number | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      const dist = Math.abs(candidate - value);
      if (dist <= thresholdCm && dist < bestDist) {
        best = candidate;
        bestDist = dist;
      }
    }

    return best;
  }

  private findHitLine(point: VectorPoint): VectorLine | null {
    let hitLine: VectorLine | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const line of this.lines()) {
      const distance = pointToSegmentDistanceCm(point, line);
      if (distance <= this.selectThresholdCm && distance < bestDistance) {
        bestDistance = distance;
        hitLine = line;
      }
    }

    return hitLine;
  }

  private startSelectionInteraction(point: VectorPoint): void {
    this.clearDraft();
    const selected = this.selectedLine();
    if (selected) {
      const endpoint = this.hitEndpointHandle(point, selected);
      if (endpoint) {
        const anchor = endpoint === 'start'
          ? { x: selected.endX, y: selected.endY }
          : { x: selected.startX, y: selected.startY };
        this.selectDragState = {
          mode: 'endpoint',
          lineId: selected.id,
          endpoint,
          anchor,
        };
        return;
      }
    }

    const hitLine = this.findHitLine(point);
    if (!hitLine) {
      // Auto-switch back to draw mode and start drawing immediately
      this.selectedLineId.set(null);
      this.selectDragState = null;
      this.guideLines.set([]);
      this.activeTool.set('draw');
      const start = this.snapStartPoint(point);
      this.draftStart.set(start);
      this.draftEnd.set(start);
      return;
    }

    this.selectedLineId.set(hitLine.id);
    this.selectDragState = {
      mode: 'line',
      lineId: hitLine.id,
      startPointer: point,
      originStart: { x: hitLine.startX, y: hitLine.startY },
      originEnd: { x: hitLine.endX, y: hitLine.endY },
    };
  }

  onLinePointerDown(event: PointerEvent, lineId: string): void {
    if (event.button !== 0) return;

    // Auto-switch from draw to select when clicking a line
    if (this.activeTool() === 'draw') {
      event.stopPropagation();
      this.activeTool.set('select');
      this.clearDraft();
      this.selectedLineId.set(lineId);

      const point = this.getMapCoords(event) ?? this.getMapCoordsClamped(event);
      const line = this.lines().find(item => item.id === lineId);
      if (!line) return;

      this.containerRef.nativeElement.setPointerCapture(event.pointerId);
      this.selectDragState = {
        mode: 'line',
        lineId,
        startPointer: point,
        originStart: { x: line.startX, y: line.startY },
        originEnd: { x: line.endX, y: line.endY },
      };
      return;
    }

    if (this.activeTool() !== 'select') return;
    event.stopPropagation();
    this.clearDraft();

    const point = this.getMapCoords(event) ?? this.getMapCoordsClamped(event);
    const line = this.lines().find(item => item.id === lineId);
    if (!line) return;

    this.containerRef.nativeElement.setPointerCapture(event.pointerId);
    this.selectedLineId.set(lineId);
    this.selectDragState = {
      mode: 'line',
      lineId,
      startPointer: point,
      originStart: { x: line.startX, y: line.startY },
      originEnd: { x: line.endX, y: line.endY },
    };
  }

  onEndpointHandlePointerDown(event: PointerEvent, lineId: string, endpoint: EndpointHandle): void {
    if (this.activeTool() !== 'select' || event.button !== 0) return;
    event.stopPropagation();
    this.clearDraft();

    const line = this.lines().find(item => item.id === lineId);
    if (!line) return;

    this.containerRef.nativeElement.setPointerCapture(event.pointerId);
    this.selectedLineId.set(lineId);
    this.selectDragState = {
      mode: 'endpoint',
      lineId,
      endpoint,
      anchor: endpoint === 'start'
        ? { x: line.endX, y: line.endY }
        : { x: line.startX, y: line.startY },
    };
  }

  private hitEndpointHandle(point: VectorPoint, line: VectorLine): EndpointHandle | null {
    const startDistance = Math.hypot(point.x - line.startX, point.y - line.startY);
    const endDistance = Math.hypot(point.x - line.endX, point.y - line.endY);

    if (startDistance <= this.endpointHandleHitThresholdCm || endDistance <= this.endpointHandleHitThresholdCm) {
      return startDistance <= endDistance ? 'start' : 'end';
    }

    return null;
  }

  private updateSelectDrag(point: VectorPoint): void {
    const drag = this.selectDragState;
    if (!drag) return;

    if (drag.mode === 'line') {
      const dx = point.x - drag.startPointer.x;
      const dy = point.y - drag.startPointer.y;
      const guided = this.applyLineMoveSmartGuides(drag.lineId, drag.originStart, drag.originEnd, dx, dy);
      const clamped = this.clampLineDelta(drag.originStart, drag.originEnd, guided.dx, guided.dy);
      const wasClamped = Math.abs(clamped.dx - guided.dx) > 0.001 || Math.abs(clamped.dy - guided.dy) > 0.001;

      this.lines.update(lines => lines.map(line => {
        if (line.id !== drag.lineId) return line;
        return {
          ...line,
          startX: roundTo(drag.originStart.x + clamped.dx, 2),
          startY: roundTo(drag.originStart.y + clamped.dy, 2),
          endX: roundTo(drag.originEnd.x + clamped.dx, 2),
          endY: roundTo(drag.originEnd.y + clamped.dy, 2),
        };
      }));

      this.guideLines.set(wasClamped ? [] : guided.guides);
      return;
    }

    const snapped = this.applySmartGuides(point, drag.anchor, drag.lineId);
    this.lines.update(lines => lines.map(line => {
      if (line.id !== drag.lineId) return line;
      if (drag.endpoint === 'start') {
        return {
          ...line,
          startX: roundTo(snapped.point.x, 2),
          startY: roundTo(snapped.point.y, 2),
        };
      }
      return {
        ...line,
        endX: roundTo(snapped.point.x, 2),
        endY: roundTo(snapped.point.y, 2),
      };
    }));
    this.guideLines.set(snapped.guides);
  }

  private applyLineMoveSmartGuides(
    lineId: string,
    originStart: VectorPoint,
    originEnd: VectorPoint,
    dx: number,
    dy: number
  ): { dx: number; dy: number; guides: GuideLine[] } {
    if (!this.showSmartGuides()) {
      return { dx, dy, guides: [] };
    }

    const anchors = this.getAnchorPoints(lineId);
    if (!anchors.length) {
      return { dx, dy, guides: [] };
    }

    let snapDx = dx;
    let snapDy = dy;
    const guides: GuideLine[] = [];

    const refsForAnchor = this.buildMovedLineReferencePoints(originStart, originEnd, snapDx, snapDy);
    let bestAnchorSnap: { offsetX: number; offsetY: number; distance: number; anchor: VectorPoint } | null = null;

    for (const ref of refsForAnchor) {
      for (const anchor of anchors) {
        const offsetX = anchor.x - ref.x;
        const offsetY = anchor.y - ref.y;
        const distance = Math.hypot(offsetX, offsetY);
        if (distance > this.endpointSnapThresholdCm) continue;
        if (!bestAnchorSnap || distance < bestAnchorSnap.distance) {
          bestAnchorSnap = { offsetX, offsetY, distance, anchor };
        }
      }
    }

    if (bestAnchorSnap) {
      snapDx += bestAnchorSnap.offsetX;
      snapDy += bestAnchorSnap.offsetY;
      guides.push({
        x1: bestAnchorSnap.anchor.x,
        y1: 0,
        x2: bestAnchorSnap.anchor.x,
        y2: TABLE_HEIGHT_CM,
        kind: 'endpoint',
      });
      guides.push({
        x1: 0,
        y1: bestAnchorSnap.anchor.y,
        x2: TABLE_WIDTH_CM,
        y2: bestAnchorSnap.anchor.y,
        kind: 'endpoint',
      });
    }

    const refs = this.buildMovedLineReferencePoints(originStart, originEnd, snapDx, snapDy);
    const xCandidates = anchors.map(anchor => anchor.x);
    const yCandidates = anchors.map(anchor => anchor.y);

    let bestX: { offset: number; targetX: number } | null = null;
    for (const ref of refs) {
      for (const targetX of xCandidates) {
        const offset = targetX - ref.x;
        const dist = Math.abs(offset);
        if (dist > this.alignmentSnapThresholdCm) continue;
        if (!bestX || dist < Math.abs(bestX.offset)) {
          bestX = { offset, targetX };
        }
      }
    }
    if (bestX) {
      snapDx += bestX.offset;
      guides.push({
        x1: bestX.targetX,
        y1: 0,
        x2: bestX.targetX,
        y2: TABLE_HEIGHT_CM,
        kind: 'alignment',
      });
    }

    const refsAfterX = this.buildMovedLineReferencePoints(originStart, originEnd, snapDx, snapDy);
    let bestY: { offset: number; targetY: number } | null = null;
    for (const ref of refsAfterX) {
      for (const targetY of yCandidates) {
        const offset = targetY - ref.y;
        const dist = Math.abs(offset);
        if (dist > this.alignmentSnapThresholdCm) continue;
        if (!bestY || dist < Math.abs(bestY.offset)) {
          bestY = { offset, targetY };
        }
      }
    }
    if (bestY) {
      snapDy += bestY.offset;
      guides.push({
        x1: 0,
        y1: bestY.targetY,
        x2: TABLE_WIDTH_CM,
        y2: bestY.targetY,
        kind: 'alignment',
      });
    }

    return { dx: snapDx, dy: snapDy, guides };
  }

  private buildMovedLineReferencePoints(
    originStart: VectorPoint,
    originEnd: VectorPoint,
    dx: number,
    dy: number
  ): VectorPoint[] {
    const start = { x: originStart.x + dx, y: originStart.y + dy };
    const end = { x: originEnd.x + dx, y: originEnd.y + dy };
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    return [start, end, midpoint];
  }

  private clampLineDelta(originStart: VectorPoint, originEnd: VectorPoint, dx: number, dy: number): { dx: number; dy: number } {
    let clampedDx = dx;
    let clampedDy = dy;

    const minX = Math.min(originStart.x, originEnd.x);
    const maxX = Math.max(originStart.x, originEnd.x);
    const minY = Math.min(originStart.y, originEnd.y);
    const maxY = Math.max(originStart.y, originEnd.y);

    if (minX + clampedDx < 0) clampedDx = -minX;
    if (maxX + clampedDx > TABLE_WIDTH_CM) clampedDx = TABLE_WIDTH_CM - maxX;
    if (minY + clampedDy < 0) clampedDy = -minY;
    if (maxY + clampedDy > TABLE_HEIGHT_CM) clampedDy = TABLE_HEIGHT_CM - maxY;

    return { dx: clampedDx, dy: clampedDy };
  }

  onLineLabelPointerDown(event: PointerEvent, lineId: string): void {
    event.stopPropagation();
    this.selectedLineId.set(lineId);
    this.activeTool.set('select');
    this.clearDraft();
  }

  deleteSelectedLine(): void {
    const selected = this.selectedLine();
    if (!selected) return;

    this.lines.update(lines => lines.filter(line => line.id !== selected.id));
    this.selectedLineId.set(null);
  }

  applySelectedLength(): void {
    const selected = this.selectedLine();
    if (!selected) return;

    const raw = this.lengthInputValue().trim().replace(',', '.');
    const numeric = Number.parseFloat(raw);

    if (!Number.isFinite(numeric) || numeric <= 0) {
      this.message.set(this.translate.instant('FLOWCHART.TABLE_MESSAGE_INVALID_LENGTH'));
      return;
    }

    const targetCm = convertToCm(numeric, this.measurementUnit());
    const dx = selected.endX - selected.startX;
    const dy = selected.endY - selected.startY;
    const currentLength = Math.hypot(dx, dy);

    const dirX = currentLength > 0.0001 ? dx / currentLength : 1;
    const dirY = currentLength > 0.0001 ? dy / currentLength : 0;

    const newEnd = {
      x: roundTo(selected.startX + dirX * targetCm, 2),
      y: roundTo(selected.startY + dirY * targetCm, 2),
    };

    if (newEnd.x < 0 || newEnd.x > TABLE_WIDTH_CM || newEnd.y < 0 || newEnd.y > TABLE_HEIGHT_CM) {
      this.message.set(this.translate.instant('FLOWCHART.TABLE_MESSAGE_LENGTH_OUT_OF_BOUNDS'));
      return;
    }

    this.lines.update(lines => lines.map(line => {
      if (line.id !== selected.id) return line;
      return {
        ...line,
        endX: newEnd.x,
        endY: newEnd.y,
      };
    }));

    this.message.set(this.translate.instant('FLOWCHART.TABLE_MESSAGE_LENGTH_APPLIED'));
  }

  applySelectedWidth(): void {
    const selected = this.selectedLine();
    if (!selected) return;

    const raw = this.widthInputValue().trim().replace(',', '.');
    const numeric = Number.parseFloat(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      this.message.set(this.translate.instant('FLOWCHART.TABLE_MESSAGE_INVALID_WIDTH'));
      return;
    }

    const targetCm = convertToCm(numeric, this.measurementUnit());
    if (targetCm < MIN_LINE_WIDTH_CM) {
      this.message.set(this.translate.instant('FLOWCHART.TABLE_MESSAGE_INVALID_WIDTH'));
      return;
    }

    this.lines.update(lines => lines.map(line => {
      if (line.id !== selected.id) return line;
      return {
        ...line,
        widthCm: roundTo(targetCm, 2),
      };
    }));

    this.message.set(this.translate.instant('FLOWCHART.TABLE_MESSAGE_WIDTH_APPLIED'));
  }

  onLengthInputKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.applySelectedLength();
  }

  onWidthInputKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.applySelectedWidth();
  }

  applyStartCoords(): void {
    this.applyEndpointCoords('start', this.startXInputValue(), this.startYInputValue());
  }

  applyEndCoords(): void {
    this.applyEndpointCoords('end', this.endXInputValue(), this.endYInputValue());
  }

  onStartCoordsKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.applyStartCoords();
  }

  onEndCoordsKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.applyEndCoords();
  }

  private applyEndpointCoords(endpoint: 'start' | 'end', rawX: string, rawY: string): void {
    const selected = this.selectedLine();
    if (!selected) return;

    const x = Number.parseFloat(rawX.trim().replace(',', '.'));
    const y = Number.parseFloat(rawY.trim().replace(',', '.'));

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.message.set(this.translate.instant('FLOWCHART.TABLE_MESSAGE_INVALID_LENGTH'));
      return;
    }

    const origin = this.coordOrigin();
    const xCm = roundTo(this.fromDisplayX(convertToCm(x, this.measurementUnit()), origin), 2);
    const yCm = roundTo(this.fromDisplayY(convertToCm(y, this.measurementUnit()), origin), 2);

    if (xCm < 0 || xCm > TABLE_WIDTH_CM || yCm < 0 || yCm > TABLE_HEIGHT_CM) {
      this.message.set(this.translate.instant('FLOWCHART.TABLE_MESSAGE_LENGTH_OUT_OF_BOUNDS'));
      return;
    }

    this.lines.update(lines => lines.map(line => {
      if (line.id !== selected.id) return line;
      if (endpoint === 'start') {
        return { ...line, startX: xCm, startY: yCm };
      }
      return { ...line, endX: xCm, endY: yCm };
    }));
  }

  lineMidpoint(line: Pick<VectorLine, 'startX' | 'startY' | 'endX' | 'endY'>): VectorPoint {
    return {
      x: (line.startX + line.endX) / 2,
      y: (line.startY + line.endY) / 2,
    };
  }

  lineColor(line: VectorLine): string {
    return line.kind === 'wall' ? '#7a879a' : '#111827';
  }

  lineStrokeWidth(line: VectorLine): number {
    return Math.max(MIN_LINE_WIDTH_CM, line.widthCm);
  }

  draftLineStrokeWidth(): number {
    return this.defaultWidthForKind(this.lineKind());
  }

  guideColor(guide: GuideLine): string {
    switch (guide.kind) {
      case 'endpoint':
        return '#22d3ee';
      case 'angle':
        return '#fb7185';
      case 'axis':
      case 'alignment':
      default:
        return '#38bdf8';
    }
  }

  labelColor(line: VectorLine): string {
    if (this.selectedLineId() === line.id) {
      return '#0ea5e9';
    }
    return line.kind === 'wall' ? '#64748b' : '#0f172a';
  }

  lineLengthLabel(line: VectorLine): string {
    return formatDistance(lineLengthCm(line), this.measurementUnit());
  }

  private defaultWidthForKind(kind: LineKind): number {
    return kind === 'wall' ? DEFAULT_WALL_WIDTH_CM : DEFAULT_LINE_WIDTH_CM;
  }

  hoverCoordLabel(coords: VectorPoint): string {
    const origin = this.coordOrigin();
    const unit = this.measurementUnit();
    const x = roundTo(convertFromCm(this.toDisplayX(coords.x, origin), unit), 2);
    const y = roundTo(convertFromCm(this.toDisplayY(coords.y, origin), unit), 2);
    return `X: ${x} ${unit}, Y: ${y} ${unit}`;
  }

  setCoordOrigin(origin: CoordOrigin): void {
    this.coordOrigin.set(origin);
  }

  measurementLabel(valueCm: number): string {
    return formatDistance(valueCm, this.measurementUnit());
  }

  exportMapFile(): void {
    try {
      const content = JSON.stringify(this.buildMapFilePayload(), null, 2);
      const blob = new Blob([content], { type: 'application/x-flowchart-tablemap+json' });
      const timestamp = this.buildFileTimestamp();
      const fileName = `table-map-${timestamp}.${TABLE_MAP_FILE_EXTENSION}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.message.set(`Exported ${fileName}`);
    } catch (err) {
      this.message.set(`Map export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async importMapFile(): Promise<void> {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `.${TABLE_MAP_FILE_EXTENSION}`;

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      try {
        const content = await file.text();
        const importedLines = this.parseMapFile(content);
        this.lines.set(importedLines);
        this.selectedLineId.set(null);
        this.clearDraft();
        this.message.set(`Imported ${importedLines.length} line(s) from ${file.name}`);
      } catch (err) {
        this.message.set(`Map import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    input.click();
  }

  clearCanvas(): void {
    this.lines.set([]);
    this.selectedLineId.set(null);
    this.clearDraft();
    this.message.set(this.translate.instant('FLOWCHART.TABLE_MESSAGE_CLEARED'));
  }

  async loadMap(): Promise<void> {
    const base64 = this.exportRasterBase64();

    try {
      const lineSegments = this.toServiceLineSegments(this.lines().filter(line => line.kind === 'line'));
      const wallSegments = this.toServiceWallSegments(this.lines().filter(line => line.kind === 'wall'));
      this.mapService.setVectorMap(lineSegments, wallSegments);
      this.mapService.cacheVectorMapForBase64(base64, lineSegments, wallSegments);
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

  private exportRasterBase64(): string {
    const canvas = document.createElement('canvas');
    canvas.width = MAP_WIDTH;
    canvas.height = MAP_HEIGHT;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Unable to create raster export context');
    }

    const imageData = ctx.createImageData(MAP_WIDTH, MAP_HEIGHT);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }

    for (const line of this.lines()) {
      const x0 = Math.round(line.startX / CM_PER_PIXEL_X);
      const y0 = Math.round(line.startY / CM_PER_PIXEL_Y);
      const x1 = Math.round(line.endX / CM_PER_PIXEL_X);
      const y1 = Math.round(line.endY / CM_PER_PIXEL_Y);
      const color = line.kind === 'wall' ? 128 : 0;
      const cmPerPixelAvg = (CM_PER_PIXEL_X + CM_PER_PIXEL_Y) * 0.5;
      const thickness = Math.max(1, Math.round(line.widthCm / cmPerPixelAvg));

      this.rasterizeLine(imageData, x0, y0, x1, y1, color, thickness);
    }

    ctx.putImageData(imageData, 0, 0);

    return canvas.toDataURL('image/png').split(',')[1];
  }

  private rasterizeLine(
    imageData: ImageData,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    grayValue: number,
    thickness: number
  ): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let x = x0;
    let y = y0;
    const radius = Math.max(0, Math.floor((thickness - 1) / 2));

    while (true) {
      this.setPixelWithRadius(imageData, x, y, grayValue, radius);
      if (x === x1 && y === y1) break;

      const e2 = err * 2;
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

  private setPixelWithRadius(imageData: ImageData, x: number, y: number, grayValue: number, radius: number): void {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;

    for (let oy = -radius; oy <= radius; oy++) {
      for (let ox = -radius; ox <= radius; ox++) {
        const px = x + ox;
        const py = y + oy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;

        const idx = (py * width + px) * 4;
        data[idx] = grayValue;
        data[idx + 1] = grayValue;
        data[idx + 2] = grayValue;
        data[idx + 3] = 255;
      }
    }
  }

  private toServiceLineSegments(lines: VectorLine[]): LineSegmentCm[] {
    return lines.map(line => ({
      startX: line.startX,
      startY: TABLE_HEIGHT_CM - line.startY,
      endX: line.endX,
      endY: TABLE_HEIGHT_CM - line.endY,
      isDiagonal: Math.abs(line.startX - line.endX) > 0.01 && Math.abs(line.startY - line.endY) > 0.01,
      thickness: line.widthCm,
    }));
  }

  private toServiceWallSegments(lines: VectorLine[]): WallSegmentCm[] {
    return lines.map(line => ({
      startX: line.startX,
      startY: TABLE_HEIGHT_CM - line.startY,
      endX: line.endX,
      endY: TABLE_HEIGHT_CM - line.endY,
      thickness: line.widthCm,
    }));
  }

  private async importMapFromBase64(base64: string): Promise<void> {
    await this.mapService.loadMapFromBase64(base64);
    this.rebuildLinesFromMapService();
    this.selectedLineId.set(null);
    this.clearDraft();
  }

  private buildMapFilePayload(): TableMapFileV1 {
    return {
      format: TABLE_MAP_FILE_FORMAT,
      version: TABLE_MAP_FILE_VERSION,
      table: {
        widthCm: TABLE_WIDTH_CM,
        heightCm: TABLE_HEIGHT_CM,
      },
      lines: this.lines().map(line => ({
        kind: line.kind,
        startX: roundTo(line.startX, 2),
        startY: roundTo(line.startY, 2),
        endX: roundTo(line.endX, 2),
        endY: roundTo(line.endY, 2),
        widthCm: roundTo(Math.max(MIN_LINE_WIDTH_CM, line.widthCm), 2),
      })),
    };
  }

  private parseMapFile(content: string): VectorLine[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('File is not valid JSON.');
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid map file structure.');
    }

    const file = parsed as Partial<TableMapFileV1>;
    if (file.format !== TABLE_MAP_FILE_FORMAT) {
      throw new Error(`Unsupported map file format: ${String(file.format ?? 'unknown')}`);
    }
    if (file.version !== TABLE_MAP_FILE_VERSION) {
      throw new Error(`Unsupported map file version: ${String(file.version ?? 'unknown')}`);
    }

    const table = file.table;
    if (!table || typeof table !== 'object') {
      throw new Error('Missing table dimensions in map file.');
    }

    const widthCm = this.readFiniteNumber(table.widthCm, 'table.widthCm');
    const heightCm = this.readFiniteNumber(table.heightCm, 'table.heightCm');
    if (Math.abs(widthCm - TABLE_WIDTH_CM) > 0.01 || Math.abs(heightCm - TABLE_HEIGHT_CM) > 0.01) {
      throw new Error(`Map dimensions must be ${TABLE_WIDTH_CM}x${TABLE_HEIGHT_CM} cm.`);
    }

    if (!Array.isArray(file.lines)) {
      throw new Error('Map file does not contain a valid line list.');
    }

    return file.lines.map((entry, index) => this.parseMapFileLine(entry, index));
  }

  private parseMapFileLine(entry: unknown, index: number): VectorLine {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Line ${index + 1} is not an object.`);
    }

    const line = entry as Partial<TableMapFileLine>;
    if (line.kind !== 'line' && line.kind !== 'wall') {
      throw new Error(`Line ${index + 1} has invalid kind.`);
    }

    const start = clampToTable({
      x: this.readFiniteNumber(line.startX, `lines[${index}].startX`),
      y: this.readFiniteNumber(line.startY, `lines[${index}].startY`),
    });
    const end = clampToTable({
      x: this.readFiniteNumber(line.endX, `lines[${index}].endX`),
      y: this.readFiniteNumber(line.endY, `lines[${index}].endY`),
    });
    const widthCm = this.readFiniteNumber(line.widthCm, `lines[${index}].widthCm`);
    if (widthCm <= 0) {
      throw new Error(`Line ${index + 1} has invalid width.`);
    }

    return {
      id: this.createLineId(),
      kind: line.kind,
      startX: roundTo(start.x, 2),
      startY: roundTo(start.y, 2),
      endX: roundTo(end.x, 2),
      endY: roundTo(end.y, 2),
      widthCm: roundTo(Math.max(MIN_LINE_WIDTH_CM, widthCm), 2),
    };
  }

  private readFiniteNumber(value: unknown, fieldName: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Invalid number at ${fieldName}.`);
    }
    return value;
  }

  private buildFileTimestamp(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}`;
  }

  private rebuildLinesFromMapService(): void {
    const vectorLines: VectorLine[] = [];

    for (const segment of this.mapService.lineSegmentsCm()) {
      vectorLines.push({
        id: this.createLineId(),
        kind: 'line',
        startX: roundTo(segment.startX, 2),
        startY: roundTo(TABLE_HEIGHT_CM - segment.startY, 2),
        endX: roundTo(segment.endX, 2),
        endY: roundTo(TABLE_HEIGHT_CM - segment.endY, 2),
        widthCm: roundTo(segment.thickness ?? DEFAULT_LINE_WIDTH_CM, 2),
      });
    }

    for (const segment of this.mapService.wallSegmentsCm()) {
      vectorLines.push({
        id: this.createLineId(),
        kind: 'wall',
        startX: roundTo(segment.startX, 2),
        startY: roundTo(TABLE_HEIGHT_CM - segment.startY, 2),
        endX: roundTo(segment.endX, 2),
        endY: roundTo(TABLE_HEIGHT_CM - segment.endY, 2),
        widthCm: roundTo(segment.thickness ?? DEFAULT_WALL_WIDTH_CM, 2),
      });
    }

    this.lines.set(vectorLines);
  }

  private loadSavedMap(): void {
    const projectUuid = this.projectUuid();
    try {
      const request$ = projectUuid
        ? this.http.getLocalTableMap(projectUuid)
        : this.http.getTableMap();

      request$.subscribe({
        next: response => {
          if (!response.image) return;
          void this.loadSavedImage(response.image);
        },
        error: () => {
          // Silently ignore when there is no stored map.
        },
      });
    } catch {
      // Silently ignore in contexts without backend routing.
    }
  }

  private async loadSavedImage(base64: string): Promise<void> {
    try {
      await this.importMapFromBase64(base64);
      this.message.set(
        this.translate.instant('FLOWCHART.TABLE_MESSAGE_LOADED', {
          width: MAP_WIDTH,
          height: MAP_HEIGHT,
        })
      );
    } catch {
      // Ignore startup load failures.
    }
  }
}
