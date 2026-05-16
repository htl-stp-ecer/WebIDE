import {Component, effect, ElementRef, OnDestroy, signal, ViewChild} from '@angular/core';
import {MissionPanel} from './mission-panel/mission-panel';
import {Flowchart} from './flowchart/flowchart';
import {StepPanel} from './step-panel/step-panel';
import {StepDocsPanel} from './step-docs-panel/step-docs-panel';
import {CodeView} from './code-view/code-view';
import {RunLogPanel} from './flowchart/logs/run-log-panel';
import {TableVisualizationPanel} from './flowchart/table/table-visualization-panel';
import {TableEditorView} from './flowchart/table/table-editor-view';
import {ArmPanel} from './arm-panel/arm-panel';
import {RobotConfigPanel} from './flowchart/robot-settings/robot-config-panel';
import {FormsModule} from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { HttpService } from '../services/http-service';
import { HttpClient } from '@angular/common/http';
import { RunActionService } from '../services/run-action-service';
import {TableMapService, TableVisualizationService} from './flowchart/table/services';
import {Pose2D, thetaToDegrees} from './flowchart/table/models';
import {Subject} from 'rxjs';
import {debounceTime} from 'rxjs/operators';
import {NotificationService} from '../services/NotificationService';
import {TranslateService} from '@ngx-translate/core';

type ResizeSide = 'left' | 'right' | 'bottom';

const STORAGE_KEYS = {
  rightWidth: 'webide-right-panel-width',
  activeRightPanel: 'webide-active-right-panel',
  leftPanelWidth: 'webide-left-panel-width',
  activeToolPanel: 'webide-active-tool-panel',
  activeBottomPanel: 'webide-active-bottom-panel',
  bottomPanelHeight: 'webide-bottom-panel-height',
} as const;

interface ResizeState {
  side: ResizeSide;
  startX: number;
  startY: number;
  startLeft: number;
  startRight: number;
  startBottom: number;
  containerWidth: number;
  containerHeight: number;
}

export type CenterView = 'flowchart' | 'code';
export type SideToolPanel = 'missions' | null;
export type BottomToolPanel = 'logs' | 'table' | 'arm' | null;
export type RightToolPanel = 'steps' | 'docs' | 'robot' | null;

@Component({
  selector: 'app-project-view',
  imports: [
    MissionPanel,
    Flowchart,
    StepPanel,
    StepDocsPanel,
    CodeView,
    RunLogPanel,
    TableVisualizationPanel,
    TableEditorView,
    ArmPanel,
    RobotConfigPanel,
    FormsModule,
  ],
  templateUrl: './project-view.html',
  styleUrl: './project-view.scss'
})
export class ProjectView implements OnDestroy {
  private static readonly MIN_PANEL_WIDTH = 220;
  private static readonly MIN_CENTER_WIDTH = 360;
  private static readonly MIN_BOTTOM_HEIGHT = 120;
  private static readonly DEFAULT_BOTTOM_HEIGHT = 200;
  private static readonly COLLAPSED_WIDTH = 40;
  private static readonly DEFAULT_PANEL_WIDTH = 280;

  @ViewChild('layoutRoot') layoutRoot!: ElementRef<HTMLDivElement>;
  @ViewChild('leftPanel') leftPanelRef!: ElementRef<HTMLDivElement>;
  @ViewChild('rightPanel') rightPanelRef!: ElementRef<HTMLDivElement>;
  @ViewChild('tableVizRef') tableVizRef?: TableVisualizationPanel;
  @ViewChild('missionPanelRef') missionPanelRef?: MissionPanel;

  private resizeState: ResizeState | null = null;
  readonly initialLeftPanelWidth = this.loadStoredCssLength(STORAGE_KEYS.leftPanelWidth);
  readonly initialRightPanelWidth = this.loadStoredCssLength(STORAGE_KEYS.rightWidth);
  readonly initialBottomPanelHeight = this.loadStoredCssLength(STORAGE_KEYS.bottomPanelHeight);

  activeRightPanel = signal<RightToolPanel>(this.loadActiveRightPanel());
  activeToolPanel = signal<SideToolPanel>(this.loadActiveToolPanel());
  activeBottomPanel = signal<BottomToolPanel>(this.loadActiveBottomPanel());
  tableEditMode = signal(false);
  centerView = signal<CenterView>('flowchart');
  armAvailable = signal(false);
  startPoseEditMode = signal(false);
  projectUUID = '';

  private persistStartPoseSubject = new Subject<void>();

  toggleCenterView(): void {
    this.centerView.set(this.centerView() === 'flowchart' ? 'code' : 'flowchart');
  }

  constructor(
    private route: ActivatedRoute,
    private http: HttpService,
    private httpClient: HttpClient,
    readonly runAction: RunActionService,
    private vizService: TableVisualizationService,
    private mapService: TableMapService,
    private translate: TranslateService,
  ) {
    const projectUUID = this.route.snapshot.paramMap.get('uuid');
    if (!projectUUID) {
      this.http.clearDeviceBase();
      return;
    }
    this.projectUUID = projectUUID;

    // Check arm availability
    this.httpClient.get(`/api/v1/projects/${projectUUID}/arm/chain`).subscribe({
      next: () => this.armAvailable.set(true),
      error: () => {
        this.armAvailable.set(false);
        if (this.activeBottomPanel() === 'arm') {
          this.activeBottomPanel.set(null);
        }
      },
    });

    // Auto-open logs panel when a run starts
    effect(() => {
      if (this.runAction.isRunActive()) {
        this.activeBottomPanel.set('logs');
        localStorage.setItem(STORAGE_KEYS.activeBottomPanel, 'logs');
      }
    });

    this.http.getProject(projectUUID).subscribe({
      next: project => {
        const connection = project.connection;
        if (connection?.pi_address) {
          const base = connection.pi_port ? `${connection.pi_address}:${connection.pi_port}` : connection.pi_address;
          this.http.setDeviceBase(base);
        } else {
          this.http.clearDeviceBase();
        }
      },
      error: () => {
        this.http.clearDeviceBase();
      }
    });

    // Debounce persistence of start pose
    this.persistStartPoseSubject.pipe(debounceTime(300)).subscribe(() => {
      this.persistStartPoseToServer();
    });
  }

  private loadActiveRightPanel(): RightToolPanel {
    const saved = localStorage.getItem(STORAGE_KEYS.activeRightPanel);
    return (saved === 'steps' || saved === 'docs' || saved === 'robot') ? saved : null;
  }

  private loadActiveToolPanel(): SideToolPanel {
    const saved = localStorage.getItem(STORAGE_KEYS.activeToolPanel);
    return saved === 'missions' ? saved : null;
  }

  private loadActiveBottomPanel(): BottomToolPanel {
    const saved = localStorage.getItem(STORAGE_KEYS.activeBottomPanel);
    return (saved === 'logs' || saved === 'table' || saved === 'arm') ? saved : null;
  }

  private loadStoredCssLength(key: string): string | null {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }

    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? `${value}px` : null;
  }

  toggleToolPanel(panel: SideToolPanel): void {
    const current = this.activeToolPanel();
    const newPanel = current === panel ? null : panel;
    this.activeToolPanel.set(newPanel);
    localStorage.setItem(STORAGE_KEYS.activeToolPanel, newPanel ?? '');
  }

  toggleBottomPanel(panel: BottomToolPanel): void {
    const current = this.activeBottomPanel();
    const newPanel = current === panel ? null : panel;
    this.activeBottomPanel.set(newPanel);
    localStorage.setItem(STORAGE_KEYS.activeBottomPanel, newPanel ?? '');
  }

  toggleRightPanel(panel: RightToolPanel): void {
    const current = this.activeRightPanel();
    const newPanel = current === panel ? null : panel;
    this.activeRightPanel.set(newPanel);
    localStorage.setItem(STORAGE_KEYS.activeRightPanel, newPanel ?? '');

    if (newPanel) {
      const layout = this.layoutRoot?.nativeElement;
      if (layout) {
        const savedWidth = localStorage.getItem(STORAGE_KEYS.rightWidth);
        const width = savedWidth ? parseInt(savedWidth, 10) : ProjectView.DEFAULT_PANEL_WIDTH;
        layout.style.setProperty('--right-panel-width', `${width}px`);
      }
    }
  }

  toggleLeftPanel(): void {
    // Kept for compatibility if needed elsewhere, delegates to toggleToolPanel
    this.toggleToolPanel(this.activeToolPanel() === 'missions' ? null : 'missions');
  }


  // Start Pose
  get startPoseXcm(): number {
    return this.roundToTwo(this.vizService.startPose().x);
  }

  get startPoseYcm(): number {
    return this.roundToTwo(this.vizService.startPose().y);
  }

  get startPoseThetaDeg(): number {
    return this.roundToTwo(thetaToDegrees(this.vizService.startPose().theta));
  }

  setStartPoseXcm(value: number | null) {
    this.updateStartPose({x: value});
  }

  setStartPoseYcm(value: number | null) {
    this.updateStartPose({y: value});
  }

  setStartPoseThetaDeg(value: number | null) {
    this.updateStartPose({thetaDeg: value});
  }

  onStartPosePicked(pose: Pose2D) {
    this.updateStartPose({
      x: pose.x,
      y: pose.y,
      thetaDeg: thetaToDegrees(pose.theta),
    });
  }

  private updateStartPose(update: { x?: number | null; y?: number | null; thetaDeg?: number | null }) {
    const current = this.vizService.startPose();
    const config = this.mapService.config();
    const nextX = this.clampValue(this.coerceNumber(update.x, current.x), 0, config.widthCm);
    const nextY = this.clampValue(this.coerceNumber(update.y, current.y), 0, config.heightCm);
    const nextTheta = this.coerceNumber(update.thetaDeg, thetaToDegrees(current.theta));
    this.vizService.setStartPose(nextX, nextY, nextTheta);
    this.persistStartPoseSubject.next();
  }

  private persistStartPoseToServer() {
    const pose = this.vizService.startPose();
    const payload = {
      x_cm: pose.x,
      y_cm: pose.y,
      theta_deg: thetaToDegrees(pose.theta),
    };
    if (this.projectUUID) {
      this.http.updateLocalDeviceStartPose(this.projectUUID, payload).subscribe({
        error: () => {
          NotificationService.showError(
            this.translate.instant('ROBOT_SETTINGS.START_POSE_SAVE_ERROR'),
            this.translate.instant('COMMON.ERROR')
          );
        }
      });
    }
  }

  private coerceNumber(value: number | null | undefined, fallback: number): number {
    if (value === null || value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  private clampValue(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  private roundToTwo(value: number): number {
    return Math.round(value * 100) / 100;
  }

  ngOnDestroy(): void {
    this.stopResize();
  }

  startResize(event: PointerEvent, side: ResizeSide): void {
    if (!event.isPrimary || event.button !== 0) return;
    const layout = this.layoutRoot?.nativeElement;
    const leftPanel = this.leftPanelRef?.nativeElement;
    const rightPanel = this.rightPanelRef?.nativeElement;
    if (!layout || !leftPanel || !rightPanel) return;

    event.preventDefault();
    this.stopResize();
    const layoutRect = layout.getBoundingClientRect();
    const leftWidth = leftPanel.getBoundingClientRect().width;
    const rightWidth = rightPanel.getBoundingClientRect().width;
    const bottomHeight = side === 'bottom'
      ? (layout.querySelector('.panel-bottom') as HTMLElement)?.getBoundingClientRect().height ?? ProjectView.DEFAULT_BOTTOM_HEIGHT
      : 0;

    this.resizeState = {
      side,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: leftWidth,
      startRight: rightWidth,
      startBottom: bottomHeight,
      containerWidth: layoutRect.width,
      containerHeight: layoutRect.height,
    };
    window.addEventListener('pointermove', this.onResizeMove);
    window.addEventListener('pointerup', this.onResizeUp);
  }

  private onResizeMove = (event: PointerEvent): void => {
    const state = this.resizeState;
    if (!state) return;
    event.preventDefault();
    const layout = this.layoutRoot?.nativeElement;
    if (!layout) return;

    if (state.side === 'bottom') {
      if (!layout) return;
      const dy = event.clientY - state.startY;
      const maxBottom = state.containerHeight - ProjectView.MIN_BOTTOM_HEIGHT;
      const nextBottom = this.clamp(state.startBottom - dy, ProjectView.MIN_BOTTOM_HEIGHT, maxBottom);
      layout.style.setProperty('--bottom-panel-height', `${Math.round(nextBottom)}px`);
      localStorage.setItem(STORAGE_KEYS.bottomPanelHeight, String(Math.round(nextBottom)));
    } else {
      const dx = event.clientX - state.startX;
      if (state.side === 'left') {
        const maxLeft = state.containerWidth - ProjectView.MIN_CENTER_WIDTH - state.startRight;
        const nextLeft = this.clamp(state.startLeft + dx, ProjectView.MIN_PANEL_WIDTH, maxLeft);
        layout.style.setProperty('--left-panel-width', `${Math.round(nextLeft)}px`);
      } else {
        const maxRight = state.containerWidth - ProjectView.MIN_CENTER_WIDTH - state.startLeft;
        const nextRight = this.clamp(state.startRight - dx, ProjectView.MIN_PANEL_WIDTH, maxRight);
        layout.style.setProperty('--right-panel-width', `${Math.round(nextRight)}px`);
      }
    }
  };

  private onResizeUp = (): void => {
    this.stopResize();
  };

  private stopResize(): void {
    if (!this.resizeState) return;
    this.resizeState = null;
    window.removeEventListener('pointermove', this.onResizeMove);
    window.removeEventListener('pointerup', this.onResizeUp);
  }

  private clamp(value: number, min: number, max: number): number {
    if (min > max) {
      const tmp = min;
      min = max;
      max = tmp;
    }
    return Math.min(Math.max(value, min), max);
  }
}
