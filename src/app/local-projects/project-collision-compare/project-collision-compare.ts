import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, forkJoin, of, Subscription } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { MultiSelect } from 'primeng/multiselect';
import { Select } from 'primeng/select';
import { SliderModule } from 'primeng/slider';

import { HttpService } from '../../services/http-service';
import { TableMapService } from '../../project-view/flowchart/table/services';
import { Pose2D } from '../../project-view/flowchart/table/models';
import { TypeDefinition } from '../../entities/TypeDefinition';
import {
  buildProjectComparisonData,
  detectProjectCollisions,
  interpolatePoseAtTime,
  ProjectCollisionEvent,
  ProjectComparisonData,
  ProjectMapGeometry,
} from './project-collision-utils';

const LINE_THICKNESS_CM = 2.54;
const WALL_THICKNESS_CM = 2.54;
const DEFAULT_MAP_WIDTH_CM = 200;
const DEFAULT_MAP_HEIGHT_CM = 100;

@Component({
  selector: 'app-project-collision-compare',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, Dialog, MultiSelect, Select, SliderModule],
  templateUrl: './project-collision-compare.html',
  styleUrl: './project-collision-compare.scss',
})
export class ProjectCollisionCompareComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input() visible = false;
  @Input() projects: Project[] = [];

  @Output() close = new EventEmitter<void>();

  @ViewChild('canvas') canvasRef?: ElementRef<HTMLCanvasElement>;

  dialogVisible = false;
  selectedProjectIds: string[] = [];
  selectedMapProjectId: string | null = null;
  previewTimeMs = 0;
  selectedCollisionKey: string | null = null;

  readonly projectPalette = ['#2563eb', '#f97316', '#10b981', '#d946ef', '#ef4444', '#14b8a6'];

  loadedProjects: ProjectComparisonData[] = [];
  collisionEvents: ProjectCollisionEvent[] = [];
  totalDurationMs = 0;

  private readonly cache = new Map<string, ProjectComparisonData>();
  private readonly loadingIds = new Set<string>();
  private readonly errorMessages = new Map<string, string>();
  private readonly subscriptions = new Subscription();
  private readonly emptyMap = this.createEmptyMap();

  private ctx?: CanvasRenderingContext2D;
  private resizeObserver?: ResizeObserver;
  private renderFrameId: number | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly translate: TranslateService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['visible']) {
      this.dialogVisible = this.visible;
      if (this.visible) {
        this.ensureInitialSelection();
        this.syncMapSelection();
        this.ensureLoadedProjects();
        this.refreshComparisonState();
      }
    }

    if (changes['projects']) {
      this.selectedProjectIds = this.selectedProjectIds.filter(uuid => this.projects.some(project => project.uuid === uuid));
      this.ensureInitialSelection();
      this.syncMapSelection();
      if (this.dialogVisible) {
        this.ensureLoadedProjects();
        this.refreshComparisonState();
      }
    }
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;

    this.ctx = canvas.getContext('2d') ?? undefined;
    this.resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas();
      this.scheduleRender();
    });
    this.resizeObserver.observe(canvas.parentElement!);
    this.resizeCanvas();
    this.scheduleRender();
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.resizeObserver?.disconnect();
    if (this.renderFrameId !== null) {
      cancelAnimationFrame(this.renderFrameId);
      this.renderFrameId = null;
    }
  }

  get projectOptions(): { label: string; value: string }[] {
    return this.projects.map(project => ({ label: project.name, value: project.uuid }));
  }

  get mapOptions(): { label: string; value: string }[] {
    return this.selectedProjectIds
      .map(uuid => this.projects.find(project => project.uuid === uuid))
      .filter((project): project is Project => !!project)
      .map(project => ({ label: project.name, value: project.uuid }));
  }

  get hasEnoughProjects(): boolean {
    return this.selectedProjectIds.length >= 2;
  }

  get hasLoadedComparison(): boolean {
    return this.loadedProjects.length >= 2;
  }

  get isLoadingSelection(): boolean {
    return this.selectedProjectIds.some(uuid => this.loadingIds.has(uuid));
  }

  get selectedMap(): ProjectMapGeometry {
    if (!this.selectedMapProjectId) return this.emptyMap;
    return this.cache.get(this.selectedMapProjectId)?.map ?? this.emptyMap;
  }

  get selectedCollision(): ProjectCollisionEvent | null {
    return this.collisionEvents.find(event => event.key === this.selectedCollisionKey) ?? null;
  }

  onDialogHide(): void {
    this.dialogVisible = false;
    this.close.emit();
  }

  onProjectSelectionChange(value: string[] | null | undefined): void {
    const uniqueIds = Array.from(new Set((value ?? []).filter(uuid => this.projects.some(project => project.uuid === uuid))));
    this.selectedProjectIds = uniqueIds;
    this.syncMapSelection();
    this.ensureLoadedProjects();
    this.refreshComparisonState();
  }

  onMapSelectionChange(): void {
    this.scheduleRender();
  }

  onPreviewTimeChange(value: number | number[] | null | undefined): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    this.previewTimeMs = Math.max(0, Math.min(value, this.totalDurationMs));
    this.scheduleRender();
  }

  jumpToCollision(collision: ProjectCollisionEvent): void {
    this.previewTimeMs = collision.timeMs;
    this.selectedCollisionKey = collision.key;
    this.scheduleRender();
  }

  projectColor(projectUuid: string): string {
    const index = this.selectedProjectIds.indexOf(projectUuid);
    const normalized = index >= 0 ? index : 0;
    return this.projectPalette[normalized % this.projectPalette.length];
  }

  projectStatus(projectUuid: string): 'loading' | 'error' | 'ready' | 'idle' {
    if (this.loadingIds.has(projectUuid)) return 'loading';
    if (this.errorMessages.has(projectUuid)) return 'error';
    if (this.cache.has(projectUuid)) return 'ready';
    return 'idle';
  }

  projectError(projectUuid: string): string | null {
    return this.errorMessages.get(projectUuid) ?? null;
  }

  projectErrorKey(projectUuid: string): string {
    return this.errorMessages.get(projectUuid) ?? '';
  }

  projectName(projectUuid: string): string {
    return this.projects.find(project => project.uuid === projectUuid)?.name ?? projectUuid;
  }

  formatSeconds(timeMs: number): string {
    return `${(timeMs / 1000).toFixed(1)}s`;
  }

  private ensureInitialSelection(): void {
    if (this.selectedProjectIds.length > 0 || this.projects.length < 2) {
      return;
    }
    this.selectedProjectIds = this.projects.slice(0, 2).map(project => project.uuid);
  }

  private syncMapSelection(): void {
    if (this.selectedMapProjectId && this.selectedProjectIds.includes(this.selectedMapProjectId)) {
      return;
    }
    this.selectedMapProjectId = this.selectedProjectIds[0] ?? null;
  }

  private ensureLoadedProjects(): void {
    for (const uuid of this.selectedProjectIds) {
      if (this.cache.has(uuid) || this.loadingIds.has(uuid)) continue;
      const project = this.projects.find(entry => entry.uuid === uuid);
      if (!project) continue;
      this.loadProject(project);
    }
  }

  private loadProject(project: Project): void {
    this.loadingIds.add(project.uuid);
    this.errorMessages.delete(project.uuid);
    this.refreshComparisonState();

    const request$ = forkJoin({
      info: this.http.getLocalDeviceInfo(project.uuid).pipe(catchError(() => of(null))),
      simulation: this.http.getProjectSimulationData(project.uuid),
      typeDefinitions: this.http.getTypeDefinitions(project.uuid).pipe(catchError(() => of([] as TypeDefinition[]))),
      mapResponse: this.http.getLocalTableMap(project.uuid).pipe(catchError(() => of({ image: null }))),
    });

    const subscription = request$.subscribe({
      next: async ({ info, simulation, typeDefinitions, mapResponse }) => {
        try {
          const map = await this.loadProjectMap(mapResponse.image);
          const data = buildProjectComparisonData(project, simulation, info, map, typeDefinitions);
          this.cache.set(project.uuid, data);
          this.errorMessages.delete(project.uuid);
        } catch (error) {
          console.error('Failed to build comparison data for project', project.uuid, error);
          this.errorMessages.set(project.uuid, 'LOCAL_PROJECTS.COMPARE_LOAD_ERROR');
        } finally {
          this.loadingIds.delete(project.uuid);
          this.refreshComparisonState();
        }
      },
      error: error => {
        console.error('Failed to load comparison data for project', project.uuid, error);
        this.loadingIds.delete(project.uuid);
        this.errorMessages.set(project.uuid, 'LOCAL_PROJECTS.COMPARE_LOAD_ERROR');
        this.refreshComparisonState();
      },
    });

    this.subscriptions.add(subscription);
  }

  private async loadProjectMap(base64: string | null): Promise<ProjectMapGeometry> {
    const service = new TableMapService();
    if (base64) {
      await service.loadMapFromBase64(base64);
    }

    const config = service.config();
    return {
      config: {
        widthCm: config.widthCm,
        heightCm: config.heightCm,
        pixelsPerCm: config.pixelsPerCm,
      },
      lineSegmentsCm: [...service.lineSegmentsCm()],
      wallSegmentsCm: [...service.wallSegmentsCm()],
      isLoaded: service.isLoaded(),
      isOnBlackLine: (xCm: number, yCm: number) => service.isOnBlackLine(xCm, yCm),
    };
  }

  private refreshComparisonState(): void {
    this.loadedProjects = this.selectedProjectIds
      .map(uuid => this.cache.get(uuid))
      .filter((project): project is ProjectComparisonData => !!project);
    this.totalDurationMs = Math.max(...this.loadedProjects.map(project => project.timedPath.totalDurationMs), 0);
    this.previewTimeMs = Math.max(0, Math.min(this.previewTimeMs, this.totalDurationMs));
    this.collisionEvents = this.loadedProjects.length >= 2 ? detectProjectCollisions(this.loadedProjects) : [];
    if (this.selectedCollisionKey && !this.collisionEvents.some(event => event.key === this.selectedCollisionKey)) {
      this.selectedCollisionKey = this.collisionEvents[0]?.key ?? null;
    }
    this.scheduleRender();
  }

  private createEmptyMap(): ProjectMapGeometry {
    return {
      config: {
        widthCm: DEFAULT_MAP_WIDTH_CM,
        heightCm: DEFAULT_MAP_HEIGHT_CM,
        pixelsPerCm: 1,
      },
      lineSegmentsCm: [],
      wallSegmentsCm: [],
      isLoaded: false,
      isOnBlackLine: () => false,
    };
  }

  private resizeCanvas(): void {
    const canvas = this.canvasRef?.nativeElement;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;

    const parent = canvas.parentElement;
    if (!parent) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(parent.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(parent.clientHeight * dpr));
    canvas.style.width = `${parent.clientWidth}px`;
    canvas.style.height = `${parent.clientHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private scheduleRender(): void {
    if (this.renderFrameId !== null) return;
    this.renderFrameId = requestAnimationFrame(() => {
      this.renderFrameId = null;
      this.render();
    });
  }

  private render(): void {
    const canvas = this.canvasRef?.nativeElement;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.clearRect(0, 0, width, height);
    const map = this.selectedMap;
    const draw = this.getDrawParams(width, height, map.config);

    this.renderMap(ctx, map, draw);
    this.renderProjectPaths(ctx, draw);
    this.renderCollisionMarkers(ctx, draw);
    this.renderProjectRobots(ctx, draw);
  }

  private renderMap(
    ctx: CanvasRenderingContext2D,
    map: ProjectMapGeometry,
    draw: DrawParams
  ): void {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(draw.offsetX, draw.offsetY, draw.drawWidth, draw.drawHeight);

    ctx.strokeStyle = '#d4d4d8';
    ctx.lineWidth = 1;
    ctx.strokeRect(draw.offsetX, draw.offsetY, draw.drawWidth, draw.drawHeight);

    if (!map.isLoaded) {
      ctx.fillStyle = 'rgba(100, 116, 139, 0.7)';
      ctx.font = '500 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        this.translate.instant('LOCAL_PROJECTS.COMPARE_MAP_EMPTY'),
        draw.offsetX + draw.drawWidth / 2,
        draw.offsetY + draw.drawHeight / 2
      );
    }

    ctx.strokeStyle = '#000000';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const segment of map.lineSegmentsCm) {
      ctx.lineWidth = Math.max(1, (segment.thickness ?? LINE_THICKNESS_CM) * Math.min(draw.scaleX, draw.scaleY));
      const start = this.tableToCanvas(segment.startX, segment.startY, draw);
      const end = this.tableToCanvas(segment.endX, segment.endY, draw);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }

    ctx.strokeStyle = '#6b7280';
    for (const segment of map.wallSegmentsCm) {
      ctx.lineWidth = Math.max(1, (segment.thickness ?? WALL_THICKNESS_CM) * Math.min(draw.scaleX, draw.scaleY));
      const start = this.tableToCanvas(segment.startX, segment.startY, draw);
      const end = this.tableToCanvas(segment.endX, segment.endY, draw);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }
  }

  private renderProjectPaths(ctx: CanvasRenderingContext2D, draw: DrawParams): void {
    for (const project of this.loadedProjects) {
      if (project.plannedPath.length < 1) continue;
      const color = this.projectColor(project.projectUuid);

      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();

      project.plannedPath.forEach((pose, index) => {
        const point = this.tableToCanvas(pose.x, pose.y, draw);
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.stroke();

      const start = this.tableToCanvas(project.plannedPath[0].x, project.plannedPath[0].y, draw);
      const endPose = project.plannedPath[project.plannedPath.length - 1];
      const end = this.tableToCanvas(endPose.x, endPose.y, draw);

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(start.x, start.y, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(end.x, end.y, 7, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  private renderCollisionMarkers(ctx: CanvasRenderingContext2D, draw: DrawParams): void {
    for (const collision of this.collisionEvents) {
      const point = this.tableToCanvas(collision.point.x, collision.point.y, draw);
      const active = collision.key === this.selectedCollisionKey;

      ctx.save();
      ctx.fillStyle = active ? '#dc2626' : '#f97316';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, active ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  private renderProjectRobots(ctx: CanvasRenderingContext2D, draw: DrawParams): void {
    for (const project of this.loadedProjects) {
      const pose = interpolatePoseAtTime(project.timedPath, this.previewTimeMs) ?? project.startPose;
      const color = this.projectColor(project.projectUuid);
      this.renderRobotAtPose(ctx, pose, project.robotConfig, draw, color);
    }
  }

  private renderRobotAtPose(
    ctx: CanvasRenderingContext2D,
    pose: Pose2D,
    robotConfig: {
      widthCm: number;
      lengthCm: number;
      rotationCenterForwardCm: number;
      rotationCenterStrafeCm: number;
    },
    draw: DrawParams,
    color: string
  ): void {
    const rotationCenter = this.tableToCanvas(pose.x, pose.y, draw);
    const robotWidthPx = robotConfig.widthCm * draw.scaleX;
    const robotLengthPx = robotConfig.lengthCm * draw.scaleY;
    const rcOffsetForwardPx = robotConfig.rotationCenterForwardCm * draw.scaleX;
    const rcOffsetStrafePx = robotConfig.rotationCenterStrafeCm * draw.scaleY;

    ctx.save();
    ctx.translate(rotationCenter.x, rotationCenter.y);
    ctx.rotate(-pose.theta);

    const bodyCenterX = -rcOffsetForwardPx;
    const bodyCenterY = rcOffsetStrafePx;

    ctx.fillStyle = `${color}33`;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(
      bodyCenterX - robotLengthPx / 2,
      bodyCenterY - robotWidthPx / 2,
      robotLengthPx,
      robotWidthPx
    );
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    const arrowTipX = bodyCenterX + robotLengthPx / 2;
    ctx.moveTo(arrowTipX, bodyCenterY);
    ctx.lineTo(arrowTipX - 12, bodyCenterY - 7);
    ctx.lineTo(arrowTipX - 12, bodyCenterY + 7);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private getDrawParams(width: number, height: number, config: { widthCm: number; heightCm: number }): DrawParams {
    const safeWidth = Math.max(config.widthCm || DEFAULT_MAP_WIDTH_CM, 1);
    const safeHeight = Math.max(config.heightCm || DEFAULT_MAP_HEIGHT_CM, 1);
    const mapAspect = safeWidth / safeHeight;
    const canvasAspect = width / height;

    let drawWidth: number;
    let drawHeight: number;
    let offsetX: number;
    let offsetY: number;

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

    return {
      drawWidth,
      drawHeight,
      offsetX,
      offsetY,
      scaleX: drawWidth / safeWidth,
      scaleY: drawHeight / safeHeight,
    };
  }

  private tableToCanvas(xCm: number, yCm: number, draw: DrawParams): { x: number; y: number } {
    return {
      x: draw.offsetX + xCm * draw.scaleX,
      y: draw.offsetY + draw.drawHeight - yCm * draw.scaleY,
    };
  }
}

interface DrawParams {
  drawWidth: number;
  drawHeight: number;
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
}
