import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  inject,
  effect,
  input,
  output,
} from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { PlanningModeService } from './planning-mode.service';
import { formatStepForPreview } from './path-to-steps';
import { MissionStep } from '../../../../entities/MissionStep';
import { TableMapService } from '../services';

/** Hit radius for waypoint markers in pixels */
const WAYPOINT_HIT_RADIUS = 12;

/** Visual radius for waypoint markers in pixels */
const WAYPOINT_VISUAL_RADIUS = 8;

@Component({
  selector: 'app-planning-overlay',
  standalone: true,
  imports: [CommonModule, DecimalPipe, TranslateModule],
  templateUrl: './planning-overlay.component.html',
  styleUrl: './planning-overlay.component.scss',
})
export class PlanningOverlayComponent implements AfterViewInit, OnDestroy {
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

  private ctx!: CanvasRenderingContext2D;
  private animationFrameId: number | null = null;
  private resizeObserver!: ResizeObserver;

  constructor() {
    effect(() => {
      // React to waypoint and pose changes
      this.planningService.waypoints();
      this.planningService.selectedIndex();
      this.planningService.draggingIndex();
      this.planningService.startPose();
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

    // Always draw path from robot position
    this.renderPathLines(width, height);

    // Draw waypoint markers
    this.renderWaypoints(width, height);
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
      canvas.setPointerCapture(event.pointerId);
      return;
    }

    // Add new waypoint
    const tablePos = this.canvasToTable(x, y, rect.width, rect.height);
    if (tablePos) {
      this.planningService.addWaypoint(tablePos.x, tablePos.y);
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
      this.planningService.moveWaypoint(draggingIndex, tablePos.x, tablePos.y);
    }
  }

  onPointerUp(event: PointerEvent): void {
    const canvas = this.canvasRef.nativeElement;
    canvas.releasePointerCapture(event.pointerId);
    this.planningService.stopDragging();
  }

  onPointerLeave(): void {
    this.planningService.stopDragging();
  }

  onDoubleClick(event: MouseEvent): void {
    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const hitIndex = this.hitTestWaypoint(x, y, rect.width, rect.height);
    if (hitIndex !== null) {
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
}
