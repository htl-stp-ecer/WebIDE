import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  inject,
  effect,
  input,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { TableMapService } from './services';
import { TableVisualizationService } from './services';
import { Pose2D } from './models';
import { SensorStepType } from './models';

/** Line thickness in cm for rendering */
const LINE_THICKNESS_CM = 2.54;

/** Wall thickness in cm for rendering */
const WALL_THICKNESS_CM = 2.54;

/** Wall color */
const WALL_COLOR = '#6b7280';

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

  readonly mapService = inject(TableMapService);
  readonly vizService = inject(TableVisualizationService);

  private ctx!: CanvasRenderingContext2D;
  private animationFrameId: number | null = null;
  private resizeObserver!: ResizeObserver;

  constructor() {
    effect(() => {
      // React to changes in map and visualization state
      this.mapService.mapImage();
      this.mapService.lineSegmentsCm();
      this.mapService.wallSegmentsCm();
      this.vizService.computedPath();
      this.vizService.currentPose();
      this.vizService.plannedPath();
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

    // Draw map (white surface with vector lines)
    this.renderMap(width, height);

    // Draw planned path
    this.renderPlannedPath(width, height);

    // Draw path
    this.renderPath(width, height);

    // Draw ghost robot at planned end position
    this.renderGhostRobot(width, height);

    // Draw robot
    this.renderRobot(width, height);
  }

  private renderMap(width: number, height: number): void {
    const lineSegments = this.mapService.lineSegmentsCm();
    const wallSegments = this.mapService.wallSegmentsCm();
    const isLoaded = this.mapService.isLoaded();

    // Calculate aspect-fit dimensions
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

    // Draw white background (table surface)
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(offsetX, offsetY, drawWidth, drawHeight);

    // Draw a subtle border around the table
    this.ctx.strokeStyle = '#e0e0e0';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(offsetX, offsetY, drawWidth, drawHeight);

    const scaleX = drawWidth / config.widthCm;
    const scaleY = drawHeight / config.heightCm;

    if (!isLoaded) {
      // Draw "No Map Loaded" hint at bottom
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
    this.ctx.lineWidth = Math.max(1, LINE_THICKNESS_CM * Math.min(scaleX, scaleY));

    for (const seg of lineSegments) {
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
    this.ctx.lineWidth = Math.max(2, WALL_THICKNESS_CM * Math.min(scaleX, scaleY));

    for (const wall of wallSegments) {
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

  private tableToCanvas(pose: Pose2D, width: number, height: number): { x: number; y: number } {
    const { offsetX, offsetY, scaleX, scaleY, drawHeight } = this.getDrawParams(width, height);
    return {
      x: offsetX + pose.x * scaleX,
      y: offsetY + drawHeight - pose.y * scaleY,
    };
  }

  private renderPath(width: number, height: number): void {
    const pathData = this.vizService.computedPath();
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
    const planned = this.vizService.plannedPath();
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
  }

  private renderGhostRobot(width: number, height: number): void {
    const planned = this.vizService.plannedPath();
    if (!planned || planned.length === 0) return;

    const pose = planned[planned.length - 1];
    this.renderRobotAtPose(pose, width, height, {
      bodyFill: 'rgba(239, 68, 68, 0.12)',
      bodyStroke: 'rgba(239, 68, 68, 0.6)',
      arrowFill: 'rgba(239, 68, 68, 0.6)',
      rotationCenterFill: 'rgba(168, 85, 247, 0.7)',
      geometricCenterFill: 'rgba(239, 68, 68, 0.4)',
      showSensors: false,
      dashed: true,
    });
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
}
