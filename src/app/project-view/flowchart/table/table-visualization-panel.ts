import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  inject,
  effect,
  input,
  signal,
  EventEmitter,
  Output,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { TableMapService } from './services';
import { TableVisualizationService, type ComputedPath } from './services';
import { Pose2D, thetaToDegrees } from './models';
import { SensorStepType } from './models';
import { applyWallPhysicsToPathWithSegments, buildCollisionWalls, type PathWithSegments } from './physics';
import { PlanningModeService } from './planning';
import { MissionStep } from '../../../entities/MissionStep';
import { HttpService } from '../../../services/http-service';

/** Line thickness in cm for rendering */
const LINE_THICKNESS_CM = 2.54;

/** Wall thickness in cm for rendering */
const WALL_THICKNESS_CM = 2.54;

/** Wall color */
const WALL_COLOR = '#6b7280';
const HIGHLIGHT_COLOR = '#3b82f6';

/** Zoom/pan constants */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 10;
const ZOOM_STEP = 0.15;

/** Gizmo constants (canvas CSS pixels) */
const GIZMO_ARM_PX = 48;
const GIZMO_CLEARANCE_PX = 12;
const GIZMO_ARROW_SIZE = 10;
const GIZMO_ROT_RADIUS = 58;
const GIZMO_HIT_TOLERANCE = 10;

type GizmoDragMode = 'translate-x' | 'translate-y' | 'rotate' | 'body';

interface GizmoDragState {
  mode: GizmoDragMode;
  startCanvasX: number;
  startCanvasY: number;
  startTableX: number;
  startTableY: number;
  startTheta: number;
  startAngle: number;
  robotCenterX: number;
  robotCenterY: number;
}

@Component({
  selector: 'app-table-visualization-panel',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './table-visualization-panel.html',
  styleUrl: './table-visualization-panel.scss',
})
export class TableVisualizationPanel implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly visible = input<boolean>(true);
  readonly projectUuid = input<string | null>(null);
  readonly allowStartPoseEdit = input<boolean>(false);
  readonly showHeader = input<boolean>(true);
  readonly embedded = input<boolean>(false);
  readonly showPaths = input<boolean>(true);
  @Output() startPoseChange = new EventEmitter<Pose2D>();
  @Output() addPlannedSteps = new EventEmitter<MissionStep[]>();

  readonly mapService = inject(TableMapService);
  readonly vizService = inject(TableVisualizationService);
  readonly planningService = inject(PlanningModeService);
  private readonly httpService = inject(HttpService);

  private ctx!: CanvasRenderingContext2D;
  private animationFrameId: number | null = null;
  private resizeObserver!: ResizeObserver;
  private adjustedPlannedPath: Pose2D[] | null = null;
  private adjustedComputedPath: ComputedPath | null = null;
  private adjustedPlannedMissionEnds: Pose2D[] | null = null;
  private adjustedPlannedHighlightRange: { startIndex: number; endIndex: number } | null = null;

  // Zoom & pan state
  readonly zoom = signal(1);
  readonly panOffset = signal({ x: 0, y: 0 });
  private isPanning = false;
  private panStartPos = { x: 0, y: 0 };

  // Gizmo state
  private readonly isRobotSelected = signal(false);
  private gizmoDragState: GizmoDragState | null = null;

  constructor() {
    effect(() => {
      if (!this.allowStartPoseEdit()) {
        this.isRobotSelected.set(false);
      }
    });

    effect(() => {
      // React to changes in map and visualization state
      this.mapService.mapImage();
      this.mapService.lineSegmentsCm();
      const wallSegments = this.mapService.wallSegmentsCm();
      const mapConfig = this.mapService.config();
      const robotConfig = this.vizService.robotConfig();
      const collisionWalls = buildCollisionWalls(wallSegments, mapConfig);
      const plannedPath = this.vizService.plannedPath();
      const plannedMissionEndIndices = this.vizService.plannedMissionEndIndices();
      const plannedHighlightRange = this.vizService.plannedHighlightRange();
      const computedPath = this.vizService.computedPath();
      if (plannedPath) {
        const adjustedPlanned = applyWallPhysicsToPathWithSegments(plannedPath, robotConfig, collisionWalls);
        this.adjustedPlannedPath = adjustedPlanned.poses;
        this.adjustedPlannedMissionEnds = plannedMissionEndIndices?.length
          ? this.mapMissionEndIndices(plannedMissionEndIndices, adjustedPlanned, plannedPath.length)
          : null;
        this.adjustedPlannedHighlightRange = plannedHighlightRange
          ? this.mapPlannedRange(plannedHighlightRange, adjustedPlanned, plannedPath.length)
          : null;
      } else {
        this.adjustedPlannedPath = null;
        this.adjustedPlannedMissionEnds = null;
        this.adjustedPlannedHighlightRange = null;
      }
      this.adjustedComputedPath = computedPath
        ? this.applyWallPhysicsToComputedPath(computedPath, robotConfig, collisionWalls)
        : null;
      this.vizService.currentPose();
      // Trigger re-render on every live trajectory update too.
      this.vizService.liveTrajectory();
      this.vizService.liveTrajectoryActive();
      this.render();
    });
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
    this.loadStoredMap();
  }

  /** Load stored map from backend on first render */
  private loadStoredMap(): void {
    if (this.mapService.isLoaded()) return;

    const projectUuid = this.projectUuid();
    try {
      const request$ = projectUuid
        ? this.httpService.getLocalTableMap(projectUuid)
        : this.httpService.getTableMap();

      request$.subscribe({
        next: (response) => {
          if (response.map) {
            this.mapService.loadFromFtmap(response.map);
          }
        },
        error: (err) => {
          console.warn('Failed to load stored table map:', err);
        },
      });
    } catch (err) {
      console.warn('Failed to prepare table map request:', err);
    }
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

    // Dark canvas background
    this.ctx.fillStyle = '#0f0f17';
    this.ctx.fillRect(0, 0, width, height);

    // Draw map (white surface with vector lines)
    this.renderMap(width, height);

    // Draw planned path
    if (this.showPaths()) {
      this.renderPlannedPath(width, height);
    }

    // Draw path
    if (this.showPaths()) {
      this.renderPath(width, height);
    }

    // Draw live trajectory streamed from a real-sim run.
    this.renderLiveTrajectory(width, height);

    // Draw ghost robot at planned end position
    if (this.showPaths()) {
      this.renderGhostRobot(width, height);
    }

    // Draw robot
    this.renderRobot(width, height);
  }

  private renderMap(width: number, height: number): void {
    const lineSegments = this.mapService.lineSegmentsCm();
    const wallSegments = this.mapService.wallSegmentsCm();
    const isLoaded = this.mapService.isLoaded();
    const { drawWidth, drawHeight, offsetX, offsetY, scaleX, scaleY } = this.getDrawParams(width, height);

    // Draw white background (table surface)
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(offsetX, offsetY, drawWidth, drawHeight);

    // Draw a subtle border around the table
    this.ctx.strokeStyle = '#e0e0e0';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(offsetX, offsetY, drawWidth, drawHeight);

    if (!isLoaded) {
      this.ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
      this.ctx.font = '500 12px system-ui, -apple-system, sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'bottom';
      this.ctx.fillText('Draw a map in the Table Editor panel', offsetX + drawWidth / 2, offsetY + drawHeight - 8);
    }

    // Draw black line segments
    this.ctx.strokeStyle = '#000000';
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    for (const seg of lineSegments) {
      const segmentThickness = seg.thickness ?? LINE_THICKNESS_CM;
      this.ctx.lineWidth = Math.max(1, segmentThickness * Math.min(scaleX, scaleY));
      const startCanvas = this.tableToCanvasWithParams(
        seg.startX, seg.startY, offsetX, offsetY, scaleX, scaleY, drawHeight
      );
      const endCanvas = this.tableToCanvasWithParams(
        seg.endX, seg.endY, offsetX, offsetY, scaleX, scaleY, drawHeight
      );

      this.ctx.beginPath();
      this.ctx.moveTo(startCanvas.x, startCanvas.y);
      this.ctx.lineTo(endCanvas.x, endCanvas.y);
      this.ctx.stroke();
    }

    // Draw wall segments
    this.ctx.strokeStyle = WALL_COLOR;

    for (const wall of wallSegments) {
      const wallThickness = wall.thickness || WALL_THICKNESS_CM;
      this.ctx.lineWidth = Math.max(2, wallThickness * Math.min(scaleX, scaleY));
      const startCanvas = this.tableToCanvasWithParams(
        wall.startX, wall.startY, offsetX, offsetY, scaleX, scaleY, drawHeight
      );
      const endCanvas = this.tableToCanvasWithParams(
        wall.endX, wall.endY, offsetX, offsetY, scaleX, scaleY, drawHeight
      );

      this.ctx.beginPath();
      this.ctx.moveTo(startCanvas.x, startCanvas.y);
      this.ctx.lineTo(endCanvas.x, endCanvas.y);
      this.ctx.stroke();
    }

    // Draw table border
    this.ctx.strokeStyle = '#4b5563';
    this.ctx.lineWidth = Math.max(3, WALL_THICKNESS_CM * 1.5 * Math.min(scaleX, scaleY));
    this.ctx.strokeRect(offsetX, offsetY, drawWidth, drawHeight);
  }

  private tableToCanvasWithParams(
    xCm: number,
    yCm: number,
    offsetX: number,
    offsetY: number,
    scaleX: number,
    scaleY: number,
    drawHeight: number
  ): { x: number; y: number } {
    return {
      x: offsetX + xCm * scaleX,
      y: offsetY + drawHeight - yCm * scaleY,
    };
  }

  private getDrawParams(width: number, height: number) {
    const config = this.mapService.config();
    const mapAspect = config.widthCm / config.heightCm;
    const canvasAspect = width / height;
    const z = this.zoom();
    const pan = this.panOffset();

    // Base aspect-fit (zoom=1)
    let baseWidth: number, baseHeight: number, baseOffsetX: number, baseOffsetY: number;
    if (canvasAspect > mapAspect) {
      baseHeight = height;
      baseWidth = height * mapAspect;
      baseOffsetX = (width - baseWidth) / 2;
      baseOffsetY = 0;
    } else {
      baseWidth = width;
      baseHeight = width / mapAspect;
      baseOffsetX = 0;
      baseOffsetY = (height - baseHeight) / 2;
    }

    const drawWidth = baseWidth * z;
    const drawHeight = baseHeight * z;
    const offsetX = baseOffsetX * z + pan.x;
    const offsetY = baseOffsetY * z + pan.y;

    const scaleX = drawWidth / config.widthCm;
    const scaleY = drawHeight / config.heightCm;

    return { drawWidth, drawHeight, offsetX, offsetY, scaleX, scaleY };
  }

  private tableToCanvas(pose: Pose2D, width: number, height: number): { x: number; y: number } {
    const { offsetX, offsetY, scaleX, scaleY, drawHeight } = this.getDrawParams(width, height);
    return {
      x: offsetX + pose.x * scaleX,
      y: offsetY + drawHeight - pose.y * scaleY,
    };
  }

  private canvasToTable(
    canvasX: number,
    canvasY: number,
    width: number,
    height: number
  ): { x: number; y: number } | null {
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

  private renderLiveTrajectory(width: number, height: number): void {
    const trail = this.vizService.liveTrajectory();
    if (!trail || trail.length < 1) return;

    const active = this.vizService.liveTrajectoryActive();
    // Solid cyan while the sim is running; faded once it finishes so the
    // user can still inspect the final trace without it competing with the
    // planned path.
    this.ctx.strokeStyle = active ? '#22d3ee' : 'rgba(34, 211, 238, 0.55)';
    this.ctx.lineWidth = 2;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    if (trail.length >= 2) {
      this.ctx.beginPath();
      const first = this.tableToCanvas(trail[0], width, height);
      this.ctx.moveTo(first.x, first.y);
      for (let i = 1; i < trail.length; i++) {
        const p = this.tableToCanvas(trail[i], width, height);
        this.ctx.lineTo(p.x, p.y);
      }
      this.ctx.stroke();
    }

    // Dot at the start of the run so the user can always see where it began.
    const start = this.tableToCanvas(trail[0], width, height);
    this.ctx.fillStyle = active ? '#22d3ee' : 'rgba(34, 211, 238, 0.55)';
    this.ctx.beginPath();
    this.ctx.arc(start.x, start.y, 3, 0, Math.PI * 2);
    this.ctx.fill();
  }

  private renderPath(width: number, height: number): void {
    const pathData = this.adjustedComputedPath ?? this.vizService.computedPath();
    if (!pathData || pathData.poses.length < 2) return;

    const { poses, expandedSteps } = pathData;

    this.ctx.lineWidth = 2;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    for (let i = 0; i < poses.length - 1; i++) {
      const start = this.tableToCanvas(poses[i], width, height);
      const end = this.tableToCanvas(poses[i + 1], width, height);

      const color = this.getStepColor(expandedSteps, i);

      this.ctx.strokeStyle = color;
      this.ctx.beginPath();
      this.ctx.moveTo(start.x, start.y);
      this.ctx.lineTo(end.x, end.y);
      this.ctx.stroke();

      // Draw lineup indicator at end of lineup sequences
      if (this.isLastLineupStep(expandedSteps, i)) {
        this.renderLineupIndicator(poses[i + 1], width, height);
      }
    }

    // Draw start position marker
    const startCanvas = this.tableToCanvas(poses[0], width, height);
    this.ctx.fillStyle = '#4ade80';
    this.ctx.beginPath();
    this.ctx.arc(startCanvas.x, startCanvas.y, 5, 0, Math.PI * 2);
    this.ctx.fill();

    // Draw end position marker
    const endCanvas = this.tableToCanvas(poses[poses.length - 1], width, height);
    this.ctx.fillStyle = '#ef4444';
    this.ctx.beginPath();
    this.ctx.arc(endCanvas.x, endCanvas.y, 5, 0, Math.PI * 2);
    this.ctx.fill();
  }

  private renderPlannedPath(width: number, height: number): void {
    const planned = this.adjustedPlannedPath ?? this.vizService.plannedPath();
    if (!planned || planned.length < 2) return;

    this.ctx.strokeStyle = '#ef4444';
    this.ctx.lineWidth = 2;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    for (let i = 0; i < planned.length - 1; i++) {
      const start = this.tableToCanvas(planned[i], width, height);
      const end = this.tableToCanvas(planned[i + 1], width, height);

      this.ctx.beginPath();
      this.ctx.moveTo(start.x, start.y);
      this.ctx.lineTo(end.x, end.y);
      this.ctx.stroke();
    }

    const highlightRange = this.adjustedPlannedHighlightRange;
    if (!highlightRange) return;
    const startIndex = Math.max(0, Math.min(highlightRange.startIndex, planned.length - 1));
    const endIndex = Math.max(0, Math.min(highlightRange.endIndex, planned.length - 1));
    const rangeStart = Math.min(startIndex, endIndex);
    const rangeEnd = Math.max(startIndex, endIndex);
    if (rangeEnd <= rangeStart) return;

    this.ctx.strokeStyle = HIGHLIGHT_COLOR;
    this.ctx.lineWidth = 3;
    for (let i = rangeStart; i < rangeEnd; i++) {
      const start = this.tableToCanvas(planned[i], width, height);
      const end = this.tableToCanvas(planned[i + 1], width, height);
      this.ctx.beginPath();
      this.ctx.moveTo(start.x, start.y);
      this.ctx.lineTo(end.x, end.y);
      this.ctx.stroke();
    }
  }

  private getStepColor(steps: any[], index: number): string {
    if (!steps || index < 0 || index >= steps.length) {
      return '#4ade80'; // Default green
    }

    const step = steps[index];
    if (step?.isMicroStep && step.parentSensorType) {
      switch (step.parentSensorType) {
        case SensorStepType.LineUp:
          return '#22d3ee'; // Cyan
        case SensorStepType.FollowLine:
          return '#e879f9'; // Magenta
      }
    }

    return '#4ade80'; // Green
  }

  private isLastLineupStep(steps: any[], index: number): boolean {
    if (!steps || index < 0 || index >= steps.length) return false;

    const step = steps[index];
    if (!step?.isMicroStep || step.parentSensorType !== SensorStepType.LineUp) {
      return false;
    }

    if (index + 1 >= steps.length) return true;

    const nextStep = steps[index + 1];
    return !nextStep?.isMicroStep || nextStep.parentSensorType !== SensorStepType.LineUp;
  }

  private renderLineupIndicator(pose: Pose2D, width: number, height: number): void {
    const center = this.tableToCanvas(pose, width, height);
    const { scaleX } = this.getDrawParams(width, height);

    const lineLength = 15 * scaleX;
    const perpAngle = pose.theta + Math.PI / 2;

    const startX = center.x + (Math.cos(perpAngle) * lineLength) / 2;
    const startY = center.y - (Math.sin(perpAngle) * lineLength) / 2;
    const endX = center.x - (Math.cos(perpAngle) * lineLength) / 2;
    const endY = center.y + (Math.sin(perpAngle) * lineLength) / 2;

    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 3;
    this.ctx.beginPath();
    this.ctx.moveTo(startX, startY);
    this.ctx.lineTo(endX, endY);
    this.ctx.stroke();
  }

  private renderRobot(width: number, height: number): void {
    const pose = this.vizService.currentPose();
    if (!pose) return;

    this.renderRobotAtPose(pose, width, height, {
      bodyFill: 'rgba(74, 222, 128, 0.7)',
      bodyStroke: '#4ade80',
      arrowFill: '#facc15',
      rotationCenterFill: '#a855f7',
      geometricCenterFill: '#facc15',
      showSensors: true,
      dashed: false,
    });

    if (this.allowStartPoseEdit() && this.isRobotSelected()) {
      this.renderGizmo(this.vizService.startPose(), width, height);
    }
  }

  private renderGizmo(pose: Pose2D, width: number, height: number): void {
    const center = this.tableToCanvas(pose, width, height);
    const cx = center.x;
    const cy = center.y;
    const isDragging = this.gizmoDragState;

    this.ctx.save();
    this.ctx.lineCap = 'round';
    this.ctx.setLineDash([]);

    // Rotation ring (blue)
    const rotActive = isDragging?.mode === 'rotate';
    this.ctx.strokeStyle = rotActive ? '#93c5fd' : '#60a5fa';
    this.ctx.lineWidth = rotActive ? 3.5 : 2.5;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, GIZMO_ROT_RADIUS, 0, Math.PI * 2);
    this.ctx.stroke();

    // X-axis arrow (red, pointing canvas right = table +X)
    const xActive = isDragging?.mode === 'translate-x';
    this.ctx.strokeStyle = xActive ? '#fca5a5' : '#ef4444';
    this.ctx.fillStyle = xActive ? '#fca5a5' : '#ef4444';
    this.ctx.lineWidth = xActive ? 3.5 : 2.5;
    this.ctx.beginPath();
    this.ctx.moveTo(cx + GIZMO_CLEARANCE_PX, cy);
    this.ctx.lineTo(cx + GIZMO_ARM_PX, cy);
    this.ctx.stroke();
    this.ctx.beginPath();
    this.ctx.moveTo(cx + GIZMO_ARM_PX + GIZMO_ARROW_SIZE, cy);
    this.ctx.lineTo(cx + GIZMO_ARM_PX, cy - GIZMO_ARROW_SIZE * 0.5);
    this.ctx.lineTo(cx + GIZMO_ARM_PX, cy + GIZMO_ARROW_SIZE * 0.5);
    this.ctx.closePath();
    this.ctx.fill();

    // Y-axis arrow (green, pointing canvas up = table +Y)
    const yActive = isDragging?.mode === 'translate-y';
    this.ctx.strokeStyle = yActive ? '#86efac' : '#4ade80';
    this.ctx.fillStyle = yActive ? '#86efac' : '#4ade80';
    this.ctx.lineWidth = yActive ? 3.5 : 2.5;
    this.ctx.beginPath();
    this.ctx.moveTo(cx, cy - GIZMO_CLEARANCE_PX);
    this.ctx.lineTo(cx, cy - GIZMO_ARM_PX);
    this.ctx.stroke();
    this.ctx.beginPath();
    this.ctx.moveTo(cx, cy - GIZMO_ARM_PX - GIZMO_ARROW_SIZE);
    this.ctx.lineTo(cx - GIZMO_ARROW_SIZE * 0.5, cy - GIZMO_ARM_PX);
    this.ctx.lineTo(cx + GIZMO_ARROW_SIZE * 0.5, cy - GIZMO_ARM_PX);
    this.ctx.closePath();
    this.ctx.fill();

    this.ctx.restore();
  }

  private hitTestRobotBody(canvasX: number, canvasY: number, width: number, height: number): boolean {
    const pose = this.vizService.startPose();
    const center = this.tableToCanvas(pose, width, height);
    const robotConfig = this.vizService.robotConfig();
    const { scaleX, scaleY } = this.getDrawParams(width, height);

    const dx = canvasX - center.x;
    const dy = canvasY - center.y;
    // Rotate pointer to robot local frame (inverse of ctx.rotate(-theta))
    const lx = dx * Math.cos(pose.theta) - dy * Math.sin(pose.theta);
    const ly = dx * Math.sin(pose.theta) + dy * Math.cos(pose.theta);

    const rcOffsetForwardPx = robotConfig.rotationCenterForwardCm * scaleX;
    const rcOffsetStrafePx = robotConfig.rotationCenterStrafeCm * scaleY;
    const bodyCenterX = -rcOffsetForwardPx;
    const bodyCenterY = rcOffsetStrafePx;
    const halfL = (robotConfig.lengthCm * scaleY) / 2;
    const halfW = (robotConfig.widthCm * scaleX) / 2;

    return (
      lx >= bodyCenterX - halfL &&
      lx <= bodyCenterX + halfL &&
      ly >= bodyCenterY - halfW &&
      ly <= bodyCenterY + halfW
    );
  }

  private hitTestGizmo(canvasX: number, canvasY: number, width: number, height: number): GizmoDragMode | null {
    const pose = this.vizService.startPose();
    const center = this.tableToCanvas(pose, width, height);
    const dx = canvasX - center.x;
    const dy = canvasY - center.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Rotation ring — full circle hit
    if (Math.abs(dist - GIZMO_ROT_RADIUS) <= GIZMO_HIT_TOLERANCE) {
      return 'rotate';
    }

    // X-axis handle (canvas right, Y tolerance)
    if (
      dx >= GIZMO_CLEARANCE_PX &&
      dx <= GIZMO_ARM_PX + GIZMO_ARROW_SIZE &&
      Math.abs(dy) <= GIZMO_HIT_TOLERANCE
    ) {
      return 'translate-x';
    }

    // Y-axis handle (canvas up = negative Y, X tolerance)
    if (
      dy <= -GIZMO_CLEARANCE_PX &&
      dy >= -(GIZMO_ARM_PX + GIZMO_ARROW_SIZE) &&
      Math.abs(dx) <= GIZMO_HIT_TOLERANCE
    ) {
      return 'translate-y';
    }

    return null;
  }

  private handleGizmoDrag(canvasX: number, canvasY: number, width: number, height: number): void {
    const state = this.gizmoDragState!;
    const { scaleX, scaleY } = this.getDrawParams(width, height);
    let newPose: Pose2D;

    if (state.mode === 'translate-x') {
      const dxTable = (canvasX - state.startCanvasX) / scaleX;
      newPose = { x: state.startTableX + dxTable, y: state.startTableY, theta: state.startTheta };
    } else if (state.mode === 'translate-y') {
      const dyTable = -(canvasY - state.startCanvasY) / scaleY;
      newPose = { x: state.startTableX, y: state.startTableY + dyTable, theta: state.startTheta };
    } else if (state.mode === 'body') {
      const dxTable = (canvasX - state.startCanvasX) / scaleX;
      const dyTable = -(canvasY - state.startCanvasY) / scaleY;
      newPose = { x: state.startTableX + dxTable, y: state.startTableY + dyTable, theta: state.startTheta };
    } else {
      // rotate
      const currentAngle = Math.atan2(-(canvasY - state.robotCenterY), canvasX - state.robotCenterX);
      let deltaAngle = currentAngle - state.startAngle;
      // Normalise to [-π, π] to avoid jumps when crossing ±180°
      if (deltaAngle > Math.PI) deltaAngle -= 2 * Math.PI;
      if (deltaAngle < -Math.PI) deltaAngle += 2 * Math.PI;
      newPose = { x: state.startTableX, y: state.startTableY, theta: state.startTheta + deltaAngle };
    }

    this.vizService.setStartPose(newPose.x, newPose.y, thetaToDegrees(newPose.theta));
    this.startPoseChange.emit(newPose);
  }

  private renderGhostRobot(width: number, height: number): void {
    let ghostPoses = this.adjustedPlannedMissionEnds;
    if (!ghostPoses || ghostPoses.length === 0) {
      const planned = this.adjustedPlannedPath ?? this.vizService.plannedPath();
      if (!planned || planned.length === 0) return;
      ghostPoses = [planned[planned.length - 1]];
    }

    for (const pose of ghostPoses) {
      this.renderRobotAtPose(pose, width, height, {
        bodyFill: 'rgba(239, 68, 68, 0.12)',
        bodyStroke: 'rgba(239, 68, 68, 0.6)',
        arrowFill: 'rgba(239, 68, 68, 0.6)',
        rotationCenterFill: 'rgba(168, 85, 247, 0.7)',
        geometricCenterFill: 'rgba(239, 68, 68, 0.4)',
        showSensors: true,
        dashed: true,
      });
    }
  }

  private renderRobotAtPose(
    pose: Pose2D,
    width: number,
    height: number,
    options: {
      bodyFill: string;
      bodyStroke: string;
      arrowFill: string;
      rotationCenterFill: string;
      geometricCenterFill: string;
      showSensors: boolean;
      dashed: boolean;
    }
  ): void {
    const rotationCenter = this.tableToCanvas(pose, width, height);
    const robotConfig = this.vizService.robotConfig();
    const { scaleX, scaleY } = this.getDrawParams(width, height);

    const robotWidthPx = robotConfig.widthCm * scaleX;
    const robotLengthPx = robotConfig.lengthCm * scaleY;

    const rcOffsetForwardPx = robotConfig.rotationCenterForwardCm * scaleX;
    const rcOffsetStrafePx = robotConfig.rotationCenterStrafeCm * scaleY;

    this.ctx.save();
    this.ctx.translate(rotationCenter.x, rotationCenter.y);
    this.ctx.rotate(-pose.theta);

    const bodyCenterX = -rcOffsetForwardPx;
    const bodyCenterY = rcOffsetStrafePx;

    // Draw wheels (behind body)
    const wheelLengthPx = robotLengthPx * 0.55;
    const wheelWidthPx = Math.max(4, robotWidthPx * 0.13);
    this.ctx.fillStyle = options.dashed ? 'rgba(55, 65, 81, 0.5)' : '#374151';
    this.ctx.strokeStyle = options.dashed ? 'rgba(107, 114, 128, 0.4)' : '#4b5563';
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([]);
    // Left wheel
    this.ctx.beginPath();
    this.ctx.rect(
      bodyCenterX - wheelLengthPx / 2,
      bodyCenterY - robotWidthPx / 2 - wheelWidthPx,
      wheelLengthPx,
      wheelWidthPx
    );
    this.ctx.fill();
    this.ctx.stroke();
    // Right wheel
    this.ctx.beginPath();
    this.ctx.rect(
      bodyCenterX - wheelLengthPx / 2,
      bodyCenterY + robotWidthPx / 2,
      wheelLengthPx,
      wheelWidthPx
    );
    this.ctx.fill();
    this.ctx.stroke();

    // Draw robot body
    this.ctx.fillStyle = options.bodyFill;
    this.ctx.strokeStyle = options.bodyStroke;
    this.ctx.lineWidth = 2;
    if (options.dashed) {
      this.ctx.setLineDash([6, 4]);
    }
    this.ctx.beginPath();
    this.ctx.rect(
      bodyCenterX - robotLengthPx / 2,
      bodyCenterY - robotWidthPx / 2,
      robotLengthPx,
      robotWidthPx
    );
    this.ctx.fill();
    this.ctx.stroke();
    if (options.dashed) {
      this.ctx.setLineDash([]);
    }

    // Draw forward indicator (arrow)
    this.ctx.fillStyle = options.arrowFill;
    this.ctx.beginPath();
    const arrowTipX = bodyCenterX + robotLengthPx / 2;
    this.ctx.moveTo(arrowTipX, bodyCenterY);
    this.ctx.lineTo(arrowTipX - 10, bodyCenterY - 6);
    this.ctx.lineTo(arrowTipX - 10, bodyCenterY + 6);
    this.ctx.closePath();
    this.ctx.fill();

    // Draw rotation center marker
    this.ctx.fillStyle = options.rotationCenterFill;
    this.ctx.beginPath();
    this.ctx.arc(0, 0, 4, 0, Math.PI * 2);
    this.ctx.fill();

    // Draw geometric center marker (if offset is non-zero)
    if (robotConfig.rotationCenterForwardCm !== 0 || robotConfig.rotationCenterStrafeCm !== 0) {
      this.ctx.fillStyle = options.geometricCenterFill;
      this.ctx.beginPath();
      this.ctx.arc(bodyCenterX, bodyCenterY, 3, 0, Math.PI * 2);
      this.ctx.fill();
    }

    // Draw sensors
    if (options.showSensors) {
      const sensorConfig = this.vizService.sensorConfig();
      for (const sensor of sensorConfig.lineSensors) {
        const sensorX = bodyCenterX + sensor.forwardCm * scaleX;
        const sensorY = bodyCenterY - sensor.strafeCm * scaleY;

        this.ctx.fillStyle = '#22d3ee';
        this.ctx.beginPath();
        this.ctx.arc(sensorX, sensorY, 3, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }

    this.ctx.restore();
  }

  private applyWallPhysicsToComputedPath(
    path: ComputedPath,
    robotConfig: { widthCm: number; lengthCm: number; rotationCenterForwardCm: number; rotationCenterStrafeCm: number },
    walls: { startX: number; startY: number; endX: number; endY: number }[]
  ): ComputedPath {
    const adjusted = applyWallPhysicsToPathWithSegments(path.poses, robotConfig, walls);
    const expandedSteps = adjusted.segments.map(idx => path.expandedSteps[idx] ?? {});
    return { poses: adjusted.poses, expandedSteps };
  }

  private mapMissionEndIndices(
    missionEndIndices: number[],
    adjusted: PathWithSegments,
    plannedLength: number
  ): Pose2D[] {
    if (!missionEndIndices.length || !adjusted.poses.length) return [];

    const segmentCount = Math.max(0, plannedLength - 1);
    if (segmentCount === 0) {
      return missionEndIndices.map(() => adjusted.poses[0]);
    }

    const segmentEndIndex = this.buildSegmentEndIndex(adjusted, segmentCount);

    return missionEndIndices
      .filter(index => index >= 0)
      .map(index => {
        if (index === 0) return adjusted.poses[0];
        const segmentIndex = Math.min(index - 1, segmentCount - 1);
        const adjustedIndex = segmentEndIndex[segmentIndex] ?? 0;
        return adjusted.poses[adjustedIndex] ?? adjusted.poses[0];
      });
  }

  private mapPlannedRange(
    range: { startIndex: number; endIndex: number },
    adjusted: PathWithSegments,
    plannedLength: number
  ): { startIndex: number; endIndex: number } | null {
    if (!adjusted.poses.length) return null;
    const segmentCount = Math.max(0, plannedLength - 1);
    if (segmentCount === 0) {
      return { startIndex: 0, endIndex: 0 };
    }

    const segmentEndIndex = this.buildSegmentEndIndex(adjusted, segmentCount);
    const mapIndex = (index: number): number => {
      if (index <= 0) return 0;
      const segmentIndex = Math.min(index - 1, segmentCount - 1);
      return segmentEndIndex[segmentIndex] ?? 0;
    };

    return {
      startIndex: mapIndex(range.startIndex),
      endIndex: mapIndex(range.endIndex),
    };
  }

  private buildSegmentEndIndex(adjusted: PathWithSegments, segmentCount: number): number[] {
    const segmentEndIndex = new Array<number>(segmentCount).fill(0);
    for (let i = 0; i < adjusted.segments.length; i++) {
      const segmentIndex = adjusted.segments[i];
      if (segmentIndex < 0 || segmentIndex >= segmentCount) continue;
      segmentEndIndex[segmentIndex] = i + 1;
    }

    for (let i = 1; i < segmentCount; i++) {
      if (segmentEndIndex[i] === 0) {
        segmentEndIndex[i] = segmentEndIndex[i - 1];
      }
    }

    return segmentEndIndex;
  }

  // --- Zoom & Pan ---

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const oldZoom = this.zoom();
    const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    const newZoom = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom + delta)) * 100) / 100;
    if (newZoom === oldZoom) return;

    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
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

  onCanvasPointerDown(event: PointerEvent): void {
    // Middle mouse → pan
    if (event.button === 1) {
      event.preventDefault();
      this.isPanning = true;
      this.panStartPos = { x: event.clientX, y: event.clientY };
      this.canvasRef.nativeElement.setPointerCapture(event.pointerId);
      return;
    }

    if (event.button !== 0 || !this.allowStartPoseEdit()) return;

    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;
    const pose = this.vizService.startPose();

    // If robot is selected, check gizmo handles first
    if (this.isRobotSelected()) {
      const dragMode = this.hitTestGizmo(canvasX, canvasY, rect.width, rect.height);
      if (dragMode) {
        const center = this.tableToCanvas(pose, rect.width, rect.height);
        this.gizmoDragState = {
          mode: dragMode,
          startCanvasX: canvasX,
          startCanvasY: canvasY,
          startTableX: pose.x,
          startTableY: pose.y,
          startTheta: pose.theta,
          startAngle: Math.atan2(-(canvasY - center.y), canvasX - center.x),
          robotCenterX: center.x,
          robotCenterY: center.y,
        };
        canvas.setPointerCapture(event.pointerId);
        return;
      }

      // Click on robot body → start free-drag
      if (this.hitTestRobotBody(canvasX, canvasY, rect.width, rect.height)) {
        const center = this.tableToCanvas(pose, rect.width, rect.height);
        this.gizmoDragState = {
          mode: 'body',
          startCanvasX: canvasX,
          startCanvasY: canvasY,
          startTableX: pose.x,
          startTableY: pose.y,
          startTheta: pose.theta,
          startAngle: 0,
          robotCenterX: center.x,
          robotCenterY: center.y,
        };
        canvas.setPointerCapture(event.pointerId);
        return;
      }

      // Click outside robot/gizmo → deselect
      this.isRobotSelected.set(false);
      return;
    }

    // Robot not selected — click on body selects it
    if (this.hitTestRobotBody(canvasX, canvasY, rect.width, rect.height)) {
      this.isRobotSelected.set(true);
    }
  }

  onCanvasPointerMove(event: PointerEvent): void {
    if (this.isPanning) {
      const dx = event.clientX - this.panStartPos.x;
      const dy = event.clientY - this.panStartPos.y;
      this.panStartPos = { x: event.clientX, y: event.clientY };
      this.panOffset.update(p => ({ x: p.x + dx, y: p.y + dy }));
      return;
    }

    if (this.gizmoDragState) {
      const canvas = this.canvasRef.nativeElement;
      const rect = canvas.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;
      this.handleGizmoDrag(canvasX, canvasY, rect.width, rect.height);
    }
  }

  onCanvasPointerUp(event: PointerEvent): void {
    if (this.isPanning) {
      this.isPanning = false;
      this.canvasRef.nativeElement.releasePointerCapture(event.pointerId);
    }
    if (this.gizmoDragState) {
      this.gizmoDragState = null;
      this.canvasRef.nativeElement.releasePointerCapture(event.pointerId);
    }
  }

  onDoubleClick(): void {
    this.fitToView();
  }

  fitToView(): void {
    this.zoom.set(1);
    this.panOffset.set({ x: 0, y: 0 });
  }

  // --- Planning Mode ---

  openPlanningOverlay(): void {
    const startPose = this.getPlanningStartPose();
    this.planningService.setStartPose(startPose.x, startPose.y, startPose.theta);
    this.planningService.activate();
  }

  private getPlanningStartPose(): Pose2D {
    const missionEnds = this.adjustedPlannedMissionEnds;
    if (missionEnds && missionEnds.length > 0) {
      return missionEnds[missionEnds.length - 1];
    }

    const adjusted = this.adjustedPlannedPath;
    if (adjusted && adjusted.length > 0) {
      return adjusted[adjusted.length - 1];
    }

    const planned = this.vizService.plannedPath();
    if (planned && planned.length > 0) {
      return planned[planned.length - 1];
    }

    return this.vizService.startPose();
  }

  onPlanningAddSteps(steps: MissionStep[]): void {
    this.addPlannedSteps.emit(steps);
  }

  onPlanningClose(): void {
    this.planningService.deactivate();
  }
}
