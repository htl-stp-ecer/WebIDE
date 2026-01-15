import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnInit,
  OnDestroy,
  inject,
  effect,
  input,
  output,
  signal,
  HostListener,
} from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { SliderModule } from 'primeng/slider';
import { ToggleButtonModule } from 'primeng/togglebutton';
import { TooltipModule } from 'primeng/tooltip';
import { PlanningModeService } from './planning-mode.service';
import { formatStepForPreview } from './path-to-steps';
import { MissionStep } from '../../../../entities/MissionStep';
import { TableMapService, TableVisualizationService } from '../services';
import { HttpService } from '../../../../services/http-service';

/** Hit radius for waypoint markers in pixels */
const WAYPOINT_HIT_RADIUS = 12;

/** Visual radius for waypoint markers in pixels */
const WAYPOINT_VISUAL_RADIUS = 8;

/** Snap configuration constants */
const SNAP_CONFIG = {
  /** Grid size in cm */
  gridSize: 5,
  /** Angle increments in degrees for angle snap */
  angleIncrements: [0, 45, 90, 135, 180, 225, 270, 315, 360],
  /** Distance threshold in cm to snap to a black line */
  lineSnapDistance: 3,
  /** Visual colors */
  gridColor: 'rgba(59, 130, 246, 0.15)',
  gridMajorColor: 'rgba(59, 130, 246, 0.3)',
  angleGuideColor: 'rgba(251, 191, 36, 0.6)',
  lineHighlightColor: 'rgba(34, 197, 94, 0.8)',
} as const;

/** Storage keys for persisting UI state */
const STORAGE_KEYS = {
  sidebarCollapsed: 'planning-sidebar-collapsed',
  settingsExpanded: 'planning-settings-expanded',
  stepsExpanded: 'planning-steps-expanded',
  snapGrid: 'planning-snap-grid',
  snapAngles: 'planning-snap-angles',
  snapLines: 'planning-snap-lines',
} as const;

@Component({
  selector: 'app-planning-overlay',
  standalone: true,
  imports: [
    CommonModule,
    DecimalPipe,
    FormsModule,
    TranslateModule,
    ButtonModule,
    SliderModule,
    ToggleButtonModule,
    TooltipModule,
  ],
  templateUrl: './planning-overlay.component.html',
  styleUrl: './planning-overlay.component.scss',
})
export class PlanningOverlayComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  /** Parent canvas dimensions for coordinate conversion */
  readonly parentWidth = input<number>(0);
  readonly parentHeight = input<number>(0);

  /** Emitted when steps should be added to mission */
  readonly addSteps = output<MissionStep[]>();

  /** Emitted when planning mode should close */
  readonly close = output<void>();

  readonly planningService = inject(PlanningModeService);
  readonly mapService = inject(TableMapService);
  readonly vizService = inject(TableVisualizationService);
  private readonly httpService = inject(HttpService);

  // UI State signals
  readonly sidebarCollapsed = signal(localStorage.getItem(STORAGE_KEYS.sidebarCollapsed) === 'true');
  readonly settingsExpanded = signal(localStorage.getItem(STORAGE_KEYS.settingsExpanded) !== 'false');
  readonly stepsExpanded = signal(localStorage.getItem(STORAGE_KEYS.stepsExpanded) !== 'false');
  readonly snapGrid = signal(localStorage.getItem(STORAGE_KEYS.snapGrid) === 'true');
  readonly snapAngles = signal(localStorage.getItem(STORAGE_KEYS.snapAngles) === 'true');
  readonly snapLines = signal(localStorage.getItem(STORAGE_KEYS.snapLines) === 'true');

  // PrimeNG component bindings
  snapGridValue = localStorage.getItem(STORAGE_KEYS.snapGrid) === 'true';
  snapAnglesValue = localStorage.getItem(STORAGE_KEYS.snapAngles) === 'true';
  snapLinesValue = localStorage.getItem(STORAGE_KEYS.snapLines) === 'true';
  thresholdValue = 0.7; // Will be synced from service

  // Active snap feedback (for visual indicators)
  private activeAngleSnap = signal<{ fromX: number; fromY: number; angle: number } | null>(null);
  private activeLineSnap = signal<{ startX: number; startY: number; endX: number; endY: number } | null>(null);

  // Undo/Redo history
  private undoStack: { waypoints: { id: string; x: number; y: number }[] }[] = [];
  private redoStack: { waypoints: { id: string; x: number; y: number }[] }[] = [];

  private ctx!: CanvasRenderingContext2D;
  private animationFrameId: number | null = null;
  private resizeObserver!: ResizeObserver;

  constructor() {
    // Sync threshold from service
    this.thresholdValue = this.planningService.lineupThreshold();

    effect(() => {
      // React to waypoint and pose changes
      this.planningService.waypoints();
      this.planningService.selectedIndex();
      this.planningService.draggingIndex();
      this.planningService.startPose();
      this.render();
    });
  }

  ngOnInit(): void {
    this.loadStoredMap();
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d')!;

    this.resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas();
      this.render();
    });
    this.resizeObserver.observe(canvas.parentElement!);

    this.resizeCanvas();
    this.startRenderLoop();
  }

  private loadStoredMap(): void {
    if (this.mapService.isLoaded()) return;

    this.httpService.getTableMap().subscribe({
      next: (response) => {
        if (response.image) {
          this.mapService.loadMapFromBase64(response.image);
        }
      },
      error: (err) => {
        console.warn('Failed to load stored table map:', err);
      },
    });
  }

  ngOnDestroy(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.resizeObserver?.disconnect();
  }

  private resizeCanvas(): void {
    const canvas = this.canvasRef.nativeElement;
    const parent = canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = parent.clientWidth * dpr;
    canvas.height = parent.clientHeight * dpr;
    canvas.style.width = `${parent.clientWidth}px`;
    canvas.style.height = `${parent.clientHeight}px`;

    this.ctx.scale(dpr, dpr);
  }

  private startRenderLoop(): void {
    const loop = () => {
      this.render();
      this.animationFrameId = requestAnimationFrame(loop);
    };
    loop();
  }

  private render(): void {
    if (!this.ctx) return;

    const canvas = this.canvasRef.nativeElement;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    this.ctx.clearRect(0, 0, width, height);

    // Draw the map (table surface with lines)
    this.renderMap(width, height);

    // Draw the robot at its current/start position
    this.renderRobot(width, height);

    // Draw grid overlay if grid snap is enabled
    if (this.snapGrid()) {
      this.renderGridOverlay(width, height);
    }

    // Highlight nearby black lines if line snap is enabled and dragging
    if (this.snapLines() && this.planningService.draggingIndex() !== null) {
      this.renderLineHighlights(width, height);
    }

    // Draw angle guide if angle snap is active
    const angleSnap = this.activeAngleSnap();
    if (angleSnap) {
      this.renderAngleGuide(width, height, angleSnap);
    }

    // Always draw path from robot position
    this.renderPathLines(width, height);

    // Draw waypoint markers
    this.renderWaypoints(width, height);
  }

  /** Render the table map (white surface with black lines and walls) */
  private renderMap(width: number, height: number): void {
    const lineSegments = this.mapService.lineSegmentsCm();
    const wallSegments = this.mapService.wallSegmentsCm();
    const { drawWidth, drawHeight, offsetX, offsetY, scaleX, scaleY } = this.getDrawParams(width, height);

    // Draw white background (table surface)
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(offsetX, offsetY, drawWidth, drawHeight);

    // Draw a subtle border around the table
    this.ctx.strokeStyle = '#e0e0e0';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(offsetX, offsetY, drawWidth, drawHeight);

    // Draw black line segments
    this.ctx.strokeStyle = '#000000';
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.lineWidth = Math.max(1, 0.8 * Math.min(scaleX, scaleY));

    for (const seg of lineSegments) {
      const start = this.tableToCanvas(seg.startX, seg.startY, width, height);
      const end = this.tableToCanvas(seg.endX, seg.endY, width, height);

      this.ctx.beginPath();
      this.ctx.moveTo(start.x, start.y);
      this.ctx.lineTo(end.x, end.y);
      this.ctx.stroke();
    }

    // Draw wall segments (gray)
    this.ctx.strokeStyle = '#808080';
    this.ctx.lineWidth = Math.max(2, 2.5 * Math.min(scaleX, scaleY));

    for (const wall of wallSegments) {
      const start = this.tableToCanvas(wall.startX, wall.startY, width, height);
      const end = this.tableToCanvas(wall.endX, wall.endY, width, height);

      this.ctx.beginPath();
      this.ctx.moveTo(start.x, start.y);
      this.ctx.lineTo(end.x, end.y);
      this.ctx.stroke();
    }

    // Draw "No Map Loaded" hint if no data
    if (!this.mapService.isLoaded()) {
      this.ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
      this.ctx.font = '500 12px system-ui, -apple-system, sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'bottom';
      this.ctx.fillText('Draw a map in Table Editor', offsetX + drawWidth / 2, offsetY + drawHeight - 8);
    }
  }

  /** Render the robot at the planning start position */
  private renderRobot(width: number, height: number): void {
    const startPose = this.planningService.startPose();
    const robotConfig = this.vizService.robotConfig();
    const { scaleX, scaleY } = this.getDrawParams(width, height);

    const rotationCenter = this.tableToCanvas(startPose.x, startPose.y, width, height);

    const robotWidthPx = robotConfig.widthCm * scaleX;
    const robotLengthPx = robotConfig.lengthCm * scaleY;

    const rcOffsetForwardPx = robotConfig.rotationCenterForwardCm * scaleX;
    const rcOffsetStrafePx = robotConfig.rotationCenterStrafeCm * scaleY;

    this.ctx.save();
    this.ctx.translate(rotationCenter.x, rotationCenter.y);
    this.ctx.rotate(-startPose.theta);

    const bodyCenterX = -rcOffsetForwardPx;
    const bodyCenterY = rcOffsetStrafePx;

    // Draw robot body
    this.ctx.fillStyle = 'rgba(74, 222, 128, 0.7)';
    this.ctx.strokeStyle = '#4ade80';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.rect(
      bodyCenterX - robotLengthPx / 2,
      bodyCenterY - robotWidthPx / 2,
      robotLengthPx,
      robotWidthPx
    );
    this.ctx.fill();
    this.ctx.stroke();

    // Draw forward indicator (arrow)
    this.ctx.fillStyle = '#facc15';
    this.ctx.beginPath();
    const arrowTipX = bodyCenterX + robotLengthPx / 2;
    this.ctx.moveTo(arrowTipX, bodyCenterY);
    this.ctx.lineTo(arrowTipX - 10, bodyCenterY - 6);
    this.ctx.lineTo(arrowTipX - 10, bodyCenterY + 6);
    this.ctx.closePath();
    this.ctx.fill();

    // Draw rotation center marker (purple dot)
    this.ctx.fillStyle = '#a855f7';
    this.ctx.beginPath();
    this.ctx.arc(0, 0, 4, 0, Math.PI * 2);
    this.ctx.fill();

    // Draw geometric center marker if offset is non-zero
    if (robotConfig.rotationCenterForwardCm !== 0 || robotConfig.rotationCenterStrafeCm !== 0) {
      this.ctx.fillStyle = '#facc15';
      this.ctx.beginPath();
      this.ctx.arc(bodyCenterX, bodyCenterY, 3, 0, Math.PI * 2);
      this.ctx.fill();
    }

    // Draw sensors
    const sensorConfig = this.vizService.sensorConfig();
    for (const sensor of sensorConfig.lineSensors) {
      const sensorX = bodyCenterX + sensor.forwardCm * scaleX;
      const sensorY = bodyCenterY - sensor.strafeCm * scaleY;

      this.ctx.fillStyle = '#3b82f6';
      this.ctx.beginPath();
      this.ctx.arc(sensorX, sensorY, 3, 0, Math.PI * 2);
      this.ctx.fill();
    }

    this.ctx.restore();
  }

  private renderPathLines(width: number, height: number): void {
    const waypoints = this.planningService.waypoints();
    const startPose = this.planningService.startPose();

    // Build full path: planning start position + waypoints
    const pathPoints: { x: number; y: number }[] = [
      { x: startPose.x, y: startPose.y },
      ...waypoints,
    ];

    if (pathPoints.length < 2) return;

    this.ctx.strokeStyle = '#3b82f6';
    this.ctx.lineWidth = 2;
    this.ctx.setLineDash([6, 4]);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    this.ctx.beginPath();
    for (let i = 0; i < pathPoints.length; i++) {
      const pos = this.tableToCanvas(pathPoints[i].x, pathPoints[i].y, width, height);
      if (i === 0) {
        this.ctx.moveTo(pos.x, pos.y);
      } else {
        this.ctx.lineTo(pos.x, pos.y);
      }
    }
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    // Draw direction arrows between all points (including from robot)
    for (let i = 0; i < pathPoints.length - 1; i++) {
      const from = this.tableToCanvas(pathPoints[i].x, pathPoints[i].y, width, height);
      const to = this.tableToCanvas(pathPoints[i + 1].x, pathPoints[i + 1].y, width, height);
      this.drawArrow(from.x, from.y, to.x, to.y);
    }
  }

  private drawArrow(x1: number, y1: number, x2: number, y2: number): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 30) return; // Skip arrows on short segments

    // Position arrow at midpoint
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const angle = Math.atan2(dy, dx);

    const arrowSize = 8;
    this.ctx.fillStyle = '#3b82f6';
    this.ctx.beginPath();
    this.ctx.moveTo(
      midX + Math.cos(angle) * arrowSize,
      midY + Math.sin(angle) * arrowSize
    );
    this.ctx.lineTo(
      midX + Math.cos(angle + 2.5) * arrowSize,
      midY + Math.sin(angle + 2.5) * arrowSize
    );
    this.ctx.lineTo(
      midX + Math.cos(angle - 2.5) * arrowSize,
      midY + Math.sin(angle - 2.5) * arrowSize
    );
    this.ctx.closePath();
    this.ctx.fill();
  }

  private renderWaypoints(width: number, height: number): void {
    const waypoints = this.planningService.waypoints();
    const selectedIndex = this.planningService.selectedIndex();
    const draggingIndex = this.planningService.draggingIndex();

    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      const pos = this.tableToCanvas(wp.x, wp.y, width, height);
      const isSelected = selectedIndex === i;
      const isDragging = draggingIndex === i;

      // Outer ring
      this.ctx.beginPath();
      this.ctx.arc(pos.x, pos.y, WAYPOINT_VISUAL_RADIUS, 0, Math.PI * 2);
      this.ctx.fillStyle = isSelected || isDragging
        ? 'rgba(59, 130, 246, 0.4)'
        : 'rgba(59, 130, 246, 0.2)';
      this.ctx.fill();
      this.ctx.strokeStyle = isSelected ? '#f59e0b' : '#3b82f6';
      this.ctx.lineWidth = 2;
      this.ctx.stroke();

      // Number label
      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = 'bold 10px system-ui, -apple-system, sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(String(i + 1), pos.x, pos.y);
    }
  }

  /** Render grid overlay when grid snap is enabled */
  private renderGridOverlay(width: number, height: number): void {
    const config = this.mapService.config();
    const { offsetX, offsetY, scaleX, scaleY, drawWidth, drawHeight } = this.getDrawParams(width, height);
    const gridSize = SNAP_CONFIG.gridSize;

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(offsetX, offsetY, drawWidth, drawHeight);
    this.ctx.clip();

    // Draw vertical grid lines
    for (let xCm = 0; xCm <= config.widthCm; xCm += gridSize) {
      const x = offsetX + xCm * scaleX;
      const isMajor = xCm % (gridSize * 4) === 0;
      this.ctx.strokeStyle = isMajor ? SNAP_CONFIG.gridMajorColor : SNAP_CONFIG.gridColor;
      this.ctx.lineWidth = isMajor ? 1 : 0.5;
      this.ctx.beginPath();
      this.ctx.moveTo(x, offsetY);
      this.ctx.lineTo(x, offsetY + drawHeight);
      this.ctx.stroke();
    }

    // Draw horizontal grid lines
    for (let yCm = 0; yCm <= config.heightCm; yCm += gridSize) {
      const y = offsetY + drawHeight - yCm * scaleY;
      const isMajor = yCm % (gridSize * 4) === 0;
      this.ctx.strokeStyle = isMajor ? SNAP_CONFIG.gridMajorColor : SNAP_CONFIG.gridColor;
      this.ctx.lineWidth = isMajor ? 1 : 0.5;
      this.ctx.beginPath();
      this.ctx.moveTo(offsetX, y);
      this.ctx.lineTo(offsetX + drawWidth, y);
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  /** Render highlights for nearby black lines when line snap is enabled */
  private renderLineHighlights(width: number, height: number): void {
    const lineSnap = this.activeLineSnap();
    if (!lineSnap) return;

    const start = this.tableToCanvas(lineSnap.startX, lineSnap.startY, width, height);
    const end = this.tableToCanvas(lineSnap.endX, lineSnap.endY, width, height);

    this.ctx.strokeStyle = SNAP_CONFIG.lineHighlightColor;
    this.ctx.lineWidth = 4;
    this.ctx.lineCap = 'round';
    this.ctx.beginPath();
    this.ctx.moveTo(start.x, start.y);
    this.ctx.lineTo(end.x, end.y);
    this.ctx.stroke();

    // Draw glow effect
    this.ctx.strokeStyle = 'rgba(34, 197, 94, 0.3)';
    this.ctx.lineWidth = 8;
    this.ctx.beginPath();
    this.ctx.moveTo(start.x, start.y);
    this.ctx.lineTo(end.x, end.y);
    this.ctx.stroke();
  }

  /** Render angle guide line when angle snap is active */
  private renderAngleGuide(
    width: number,
    height: number,
    snap: { fromX: number; fromY: number; angle: number }
  ): void {
    const fromPos = this.tableToCanvas(snap.fromX, snap.fromY, width, height);
    const guideLength = 150; // pixels

    // Convert angle to radians (adjusting for canvas Y-axis inversion)
    const angleRad = (-snap.angle * Math.PI) / 180;

    const toX = fromPos.x + Math.cos(angleRad) * guideLength;
    const toY = fromPos.y + Math.sin(angleRad) * guideLength;

    // Draw dashed guide line
    this.ctx.strokeStyle = SNAP_CONFIG.angleGuideColor;
    this.ctx.lineWidth = 2;
    this.ctx.setLineDash([8, 4]);
    this.ctx.lineCap = 'round';
    this.ctx.beginPath();
    this.ctx.moveTo(fromPos.x, fromPos.y);
    this.ctx.lineTo(toX, toY);
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    // Draw angle label
    const labelX = fromPos.x + Math.cos(angleRad) * 40;
    const labelY = fromPos.y + Math.sin(angleRad) * 40;
    this.ctx.fillStyle = SNAP_CONFIG.angleGuideColor;
    this.ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(`${snap.angle}°`, labelX, labelY);
  }

  private getDrawParams(width: number, height: number) {
    const config = this.mapService.config();
    const mapAspect = config.widthCm / config.heightCm;
    const canvasAspect = width / height;

    let drawWidth: number, drawHeight: number, offsetX: number, offsetY: number;

    if (canvasAspect > mapAspect) {
      drawHeight = height;
      drawWidth = height * mapAspect;
      offsetX = (width - drawWidth) / 2;
      offsetY = 0;
    } else {
      drawWidth = width;
      drawHeight = width / mapAspect;
      offsetX = 0;
      offsetY = (height - drawHeight) / 2;
    }

    const scaleX = drawWidth / config.widthCm;
    const scaleY = drawHeight / config.heightCm;

    return { drawWidth, drawHeight, offsetX, offsetY, scaleX, scaleY };
  }

  private tableToCanvas(xCm: number, yCm: number, width: number, height: number): { x: number; y: number } {
    const { offsetX, offsetY, scaleX, scaleY, drawHeight } = this.getDrawParams(width, height);
    return {
      x: offsetX + xCm * scaleX,
      y: offsetY + drawHeight - yCm * scaleY,
    };
  }

  private canvasToTable(canvasX: number, canvasY: number, width: number, height: number): { x: number; y: number } | null {
    const { drawWidth, drawHeight, offsetX, offsetY, scaleX, scaleY } = this.getDrawParams(width, height);
    if (
      canvasX < offsetX ||
      canvasX > offsetX + drawWidth ||
      canvasY < offsetY ||
      canvasY > offsetY + drawHeight
    ) {
      return null;
    }
    return {
      x: (canvasX - offsetX) / scaleX,
      y: (drawHeight - (canvasY - offsetY)) / scaleY,
    };
  }

  // --- Snap Logic ---

  /**
   * Apply all enabled snap constraints to a position
   * @param x X coordinate in table cm
   * @param y Y coordinate in table cm
   * @param waypointIndex Index of waypoint being moved (to get previous point for angle snap)
   * @returns Snapped position
   */
  private applySnap(x: number, y: number, waypointIndex: number): { x: number; y: number } {
    let snappedX = x;
    let snappedY = y;

    // Clear previous snap indicators
    this.activeAngleSnap.set(null);
    this.activeLineSnap.set(null);

    // Get reference point for angle snap (previous waypoint or start pose)
    const waypoints = this.planningService.waypoints();
    const startPose = this.planningService.startPose();
    let refX: number, refY: number;

    if (waypointIndex === 0) {
      refX = startPose.x;
      refY = startPose.y;
    } else if (waypointIndex > 0 && waypointIndex <= waypoints.length) {
      const prev = waypoints[waypointIndex - 1];
      refX = prev.x;
      refY = prev.y;
    } else {
      refX = x;
      refY = y;
    }

    // Apply line snap first (highest priority)
    if (this.snapLines()) {
      const lineResult = this.applyLineSnap(snappedX, snappedY);
      if (lineResult) {
        snappedX = lineResult.x;
        snappedY = lineResult.y;
      }
    }

    // Apply angle snap (constrains direction from reference point)
    if (this.snapAngles()) {
      const angleResult = this.applyAngleSnap(snappedX, snappedY, refX, refY);
      snappedX = angleResult.x;
      snappedY = angleResult.y;
    }

    // Apply grid snap last (rounds to grid)
    if (this.snapGrid()) {
      const gridResult = this.applyGridSnap(snappedX, snappedY);
      snappedX = gridResult.x;
      snappedY = gridResult.y;
    }

    return { x: snappedX, y: snappedY };
  }

  /**
   * Snap position to nearest grid point
   */
  private applyGridSnap(x: number, y: number): { x: number; y: number } {
    const gridSize = SNAP_CONFIG.gridSize;
    return {
      x: Math.round(x / gridSize) * gridSize,
      y: Math.round(y / gridSize) * gridSize,
    };
  }

  /**
   * Snap angle to nearest 45° increment from reference point
   */
  private applyAngleSnap(x: number, y: number, refX: number, refY: number): { x: number; y: number } {
    const dx = x - refX;
    const dy = y - refY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 1) {
      return { x, y }; // Too close to reference, don't snap
    }

    // Calculate current angle in degrees (0° = right, 90° = up)
    const currentAngle = Math.atan2(dy, dx) * (180 / Math.PI);

    // Find nearest snap angle
    let nearestAngle = 0;
    let minDiff = 360;

    for (const snapAngle of SNAP_CONFIG.angleIncrements) {
      // Normalize angles for comparison
      const normalizedCurrent = ((currentAngle % 360) + 360) % 360;
      const normalizedSnap = ((snapAngle % 360) + 360) % 360;
      let diff = Math.abs(normalizedCurrent - normalizedSnap);
      if (diff > 180) diff = 360 - diff;

      if (diff < minDiff) {
        minDiff = diff;
        nearestAngle = snapAngle;
      }
    }

    // Convert back to position
    const angleRad = (nearestAngle * Math.PI) / 180;
    const snappedX = refX + Math.cos(angleRad) * distance;
    const snappedY = refY + Math.sin(angleRad) * distance;

    // Set visual feedback
    this.activeAngleSnap.set({
      fromX: refX,
      fromY: refY,
      angle: nearestAngle,
    });

    return { x: snappedX, y: snappedY };
  }

  /**
   * Snap to nearest black line if within threshold distance
   */
  private applyLineSnap(x: number, y: number): { x: number; y: number } | null {
    const lines = this.mapService.lineSegmentsCm();
    if (lines.length === 0) return null;

    let nearestLine: typeof lines[0] | null = null;
    let nearestDist: number = SNAP_CONFIG.lineSnapDistance;
    let nearestPoint = { x, y };

    for (const line of lines) {
      const closest = this.closestPointOnSegment(
        x, y,
        line.startX, line.startY,
        line.endX, line.endY
      );

      const dist = Math.sqrt(
        (x - closest.x) * (x - closest.x) +
        (y - closest.y) * (y - closest.y)
      );

      if (dist < nearestDist) {
        nearestDist = dist;
        nearestLine = line;
        nearestPoint = closest;
      }
    }

    if (nearestLine) {
      // Set visual feedback for line highlight
      this.activeLineSnap.set({
        startX: nearestLine.startX,
        startY: nearestLine.startY,
        endX: nearestLine.endX,
        endY: nearestLine.endY,
      });
      return nearestPoint;
    }

    return null;
  }

  /**
   * Find the closest point on a line segment to a given point
   */
  private closestPointOnSegment(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number
  ): { x: number; y: number } {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq === 0) {
      return { x: x1, y: y1 }; // Segment is a point
    }

    // Project point onto line, clamped to segment
    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));

    return {
      x: x1 + t * dx,
      y: y1 + t * dy,
    };
  }

  /**
   * Clear all snap visual indicators
   */
  private clearSnapIndicators(): void {
    this.activeAngleSnap.set(null);
    this.activeLineSnap.set(null);
  }

  // --- Event Handlers ---

  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;

    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Check if clicking on existing waypoint
    const hitIndex = this.hitTestWaypoint(x, y, rect.width, rect.height);
    if (hitIndex !== null) {
      this.planningService.selectWaypoint(hitIndex);
      this.planningService.startDragging(hitIndex);
      this.saveUndoState(); // Save state before dragging
      canvas.setPointerCapture(event.pointerId);
      return;
    }

    // Add new waypoint
    const tablePos = this.canvasToTable(x, y, rect.width, rect.height);
    if (tablePos) {
      this.saveUndoState(); // Save state before adding
      // Apply snap constraints when adding new waypoint
      const waypoints = this.planningService.waypoints();
      const snapped = this.applySnap(tablePos.x, tablePos.y, waypoints.length);
      this.planningService.addWaypoint(snapped.x, snapped.y);
      this.clearSnapIndicators(); // Clear immediately since not dragging
    }
  }

  onPointerMove(event: PointerEvent): void {
    const draggingIndex = this.planningService.draggingIndex();
    if (draggingIndex === null) return;

    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const tablePos = this.canvasToTable(x, y, rect.width, rect.height);
    if (tablePos) {
      // Apply snap constraints if any are enabled
      const snapped = this.applySnap(tablePos.x, tablePos.y, draggingIndex);
      this.planningService.moveWaypoint(draggingIndex, snapped.x, snapped.y);
    }
  }

  onPointerUp(event: PointerEvent): void {
    const canvas = this.canvasRef.nativeElement;
    canvas.releasePointerCapture(event.pointerId);
    this.planningService.stopDragging();
    this.clearSnapIndicators();
  }

  onPointerLeave(): void {
    this.planningService.stopDragging();
    this.clearSnapIndicators();
  }

  onDoubleClick(event: MouseEvent): void {
    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const hitIndex = this.hitTestWaypoint(x, y, rect.width, rect.height);
    if (hitIndex !== null) {
      this.saveUndoState(); // Save state before removing
      this.planningService.removeWaypoint(hitIndex);
    }
  }

  private hitTestWaypoint(canvasX: number, canvasY: number, width: number, height: number): number | null {
    const waypoints = this.planningService.waypoints();
    for (let i = waypoints.length - 1; i >= 0; i--) {
      const wp = waypoints[i];
      const pos = this.tableToCanvas(wp.x, wp.y, width, height);
      const dx = canvasX - pos.x;
      const dy = canvasY - pos.y;
      if (dx * dx + dy * dy <= WAYPOINT_HIT_RADIUS * WAYPOINT_HIT_RADIUS) {
        return i;
      }
    }
    return null;
  }

  // --- Actions ---

  onClear(): void {
    if (this.planningService.waypoints().length > 0) {
      this.saveUndoState(); // Save state before clearing
    }
    this.planningService.clear();
  }

  onCancel(): void {
    this.planningService.clear();
    this.close.emit();
  }

  onAddSteps(): void {
    const steps = this.planningService.consumeSteps();
    this.addSteps.emit(steps);
    this.close.emit();
  }

  // --- Helpers for template ---

  onThresholdChange(event: Event): void {
    const value = parseFloat((event.target as HTMLInputElement).value);
    this.planningService.setLineupThreshold(value);
  }

  formatStep(step: MissionStep): string {
    return formatStepForPreview(step);
  }

  getStepIcon(step: MissionStep): string {
    const fn = step.function_name;
    if (fn === 'turn_cw' || fn === 'turn_ccw' || fn === 'tank_turn_cw' || fn === 'tank_turn_ccw') {
      return 'pi pi-sync';
    }
    if (fn === 'drive_forward') {
      return 'pi pi-arrow-up';
    }
    if (fn === 'drive_backward') {
      return 'pi pi-arrow-down';
    }
    if (fn.includes('lineup')) {
      return 'pi pi-align-center';
    }
    return 'pi pi-circle';
  }

  // --- UI State Methods ---

  toggleSidebar(): void {
    const newState = !this.sidebarCollapsed();
    this.sidebarCollapsed.set(newState);
    localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, String(newState));
  }

  toggleSettingsSection(): void {
    const newState = !this.settingsExpanded();
    this.settingsExpanded.set(newState);
    localStorage.setItem(STORAGE_KEYS.settingsExpanded, String(newState));
  }

  toggleStepsSection(): void {
    const newState = !this.stepsExpanded();
    this.stepsExpanded.set(newState);
    localStorage.setItem(STORAGE_KEYS.stepsExpanded, String(newState));
  }

  toggleSnapGrid(): void {
    const newState = !this.snapGrid();
    this.snapGrid.set(newState);
    this.snapGridValue = newState;
    localStorage.setItem(STORAGE_KEYS.snapGrid, String(newState));
  }

  toggleSnapAngles(): void {
    const newState = !this.snapAngles();
    this.snapAngles.set(newState);
    this.snapAnglesValue = newState;
    localStorage.setItem(STORAGE_KEYS.snapAngles, String(newState));
  }

  toggleSnapLines(): void {
    const newState = !this.snapLines();
    this.snapLines.set(newState);
    this.snapLinesValue = newState;
    localStorage.setItem(STORAGE_KEYS.snapLines, String(newState));
  }

  // PrimeNG toggle button event handlers
  onSnapGridChange(event: { checked?: boolean }): void {
    const value = event.checked ?? false;
    this.snapGrid.set(value);
    localStorage.setItem(STORAGE_KEYS.snapGrid, String(value));
  }

  onSnapAnglesChange(event: { checked?: boolean }): void {
    const value = event.checked ?? false;
    this.snapAngles.set(value);
    localStorage.setItem(STORAGE_KEYS.snapAngles, String(value));
  }

  onSnapLinesChange(event: { checked?: boolean }): void {
    const value = event.checked ?? false;
    this.snapLines.set(value);
    localStorage.setItem(STORAGE_KEYS.snapLines, String(value));
  }

  onThresholdSliderChange(value?: number | number[]): void {
    const nextValue = Array.isArray(value) ? value[0] : (value ?? this.thresholdValue);
    this.planningService.setLineupThreshold(nextValue);
  }

  // --- Undo/Redo ---

  private saveUndoState(): void {
    const waypoints = this.planningService.waypoints().map(wp => ({ id: wp.id, x: wp.x, y: wp.y }));
    this.undoStack.push({ waypoints });
    this.redoStack = []; // Clear redo stack on new action
    // Limit stack size
    if (this.undoStack.length > 50) {
      this.undoStack.shift();
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  onUndo(): void {
    if (!this.canUndo()) return;
    const currentState = this.planningService.waypoints().map(wp => ({ id: wp.id, x: wp.x, y: wp.y }));
    this.redoStack.push({ waypoints: currentState });
    const previousState = this.undoStack.pop()!;
    this.restoreWaypoints(previousState.waypoints);
  }

  onRedo(): void {
    if (!this.canRedo()) return;
    const currentState = this.planningService.waypoints().map(wp => ({ id: wp.id, x: wp.x, y: wp.y }));
    this.undoStack.push({ waypoints: currentState });
    const nextState = this.redoStack.pop()!;
    this.restoreWaypoints(nextState.waypoints);
  }

  private restoreWaypoints(waypoints: { id: string; x: number; y: number }[]): void {
    this.planningService.clear();
    for (const wp of waypoints) {
      this.planningService.addWaypoint(wp.x, wp.y);
    }
  }

  // --- Keyboard Shortcuts ---

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (!this.planningService.isActive()) return;

    // Escape - Cancel
    if (event.key === 'Escape') {
      event.preventDefault();
      this.onCancel();
      return;
    }

    // Enter - Apply
    if (event.key === 'Enter' && this.planningService.canAddSteps()) {
      event.preventDefault();
      this.onAddSteps();
      return;
    }

    // Delete - Remove selected waypoint
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const selected = this.planningService.selectedIndex();
      if (selected !== null) {
        event.preventDefault();
        this.saveUndoState();
        this.planningService.removeWaypoint(selected);
      }
      return;
    }

    // Ctrl+Z - Undo
    if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.onUndo();
      return;
    }

    // Ctrl+Shift+Z or Ctrl+Y - Redo
    if ((event.ctrlKey || event.metaKey) && (event.key === 'Z' || event.key === 'y')) {
      event.preventDefault();
      this.onRedo();
      return;
    }

    // G - Toggle grid snap
    if (event.key === 'g' || event.key === 'G') {
      event.preventDefault();
      this.toggleSnapGrid();
      return;
    }

    // A - Toggle angle snap
    if (event.key === 'a' || event.key === 'A') {
      event.preventDefault();
      this.toggleSnapAngles();
      return;
    }

    // L - Toggle line snap
    if (event.key === 'l' || event.key === 'L') {
      event.preventDefault();
      this.toggleSnapLines();
      return;
    }
  }
}
