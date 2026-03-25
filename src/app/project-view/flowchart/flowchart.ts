import { AfterViewChecked, AfterViewInit, Component, ElementRef, HostListener, OnDestroy, OnInit, QueryList, Signal, ViewChild, ViewChildren, effect, signal, viewChild } from '@angular/core';
import { EFMarkerType, FCanvasComponent, FFlowComponent, FFlowModule } from '@foblex/flow';
import { ContextMenu, ContextMenuModule } from 'primeng/contextmenu';
import type { MenuItem } from 'primeng/api';
import { CheckboxModule } from 'primeng/checkbox';
import { FormsModule } from '@angular/forms';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectButtonModule } from 'primeng/selectbutton';
import { Tooltip } from 'primeng/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { MissionStateService } from '../../services/mission-sate-service';
import { StepsStateService } from '../../services/steps-state-service';
import { HttpService } from '../../services/http-service';
import { KeybindingsService } from '../../services/keybindings-service';
import { FlowHistory } from '../../entities/flow-history';
import { Mission } from '../../entities/Mission';
import { MissionSimulationData, ProjectSimulationData } from '../../entities/Simulation';
import { Connection, FlowComment, FlowGroup, FlowNode, FlowOrientation, Step, isMultiSensorType, parseMultiSensorSelection, resolveDefinitionType, toVal } from './models';
import { FlowchartHistoryManager } from './flowchart-history-manager';
import { FlowchartRunManager } from './flowchart-run-manager';
import { createHistoryManager, createRunManager } from './manager-factories';
import { ContextMenuState } from './context-menu-state';
import { FlowchartLookupState } from './lookups';
import { createLayoutFlags, LayoutFlags } from './layout-flags';
import { persistViewToggleState, readDarkMode, readStoredAutoLayout, readStoredViewToggleState, persistAutoLayout } from './theme-utils';
import { initializeFlowchart } from './flowchart-init';
import { handleAfterViewChecked } from './layout-handlers';
import { recomputeMergedView } from './view-merger';
import { createFlowchartActions, FlowchartActions } from './flowchart-actions';
import { TypeDefinition } from '../../entities/TypeDefinition';
import { Select } from 'primeng/select';
import { MultiSelect } from 'primeng/multiselect';
import { DecimalPipe } from '@angular/common';
import { ProgressSpinner } from 'primeng/progressspinner';
import { TableVisualizationPanel } from './table/table-visualization-panel';
import { TimingPanel, type TimingViewMode } from './timing/timing-panel';
import { RobotSettingsModal } from './robot-settings/robot-settings-modal';
import { TableMapService, TableVisualizationService } from './table/services';
import { buildPlannedPathFromProjectSimulation, buildPlannedPathFromProjectSimulationWithMissionOverride } from './table/simulation-path';
import { PlanningModeService, PlanningOverlayComponent } from './table/planning';
import { RunLogPanel } from './logs/run-log-panel';
import { generateGuid } from '@foblex/utils';

interface DefinitionOption {
  label: string;
  value: string;
}

type DefinitionGroups = Partial<Record<string, DefinitionOption[]>>;
type FloatingPanelKey = 'timing' | 'unity' | 'table' | 'logs';
//
interface PanelOffset {
  x: number;
  y: number;
}

interface PanelDragState {
  key: FloatingPanelKey;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  startRect: DOMRect;
  surfaceRect: DOMRect;
}

interface OffscreenIndicatorState {
  visible: boolean;
  x: number;
  y: number;
  angle: number;
}

const DEFAULT_VIEW_TOGGLE_STATE: Record<string, boolean> = { timestamps: true, tableVisualization: false, logs: true };
const DEFAULT_PANEL_OFFSETS: Record<FloatingPanelKey, PanelOffset> = {
  timing: { x: 0, y: 0 },
  unity: { x: 0, y: 0 },
  table: { x: 0, y: 0 },
  logs: { x: 0, y: 0 },
};
const OFFSCREEN_INDICATOR_HORIZONTAL_THRESHOLD_PX = 340;
const OFFSCREEN_INDICATOR_VERTICAL_THRESHOLD_PX = 220;
const OFFSCREEN_INDICATOR_EDGE_PADDING_PX = 40;
const OFFSCREEN_INDICATOR_BOUNDS_PADDING_PX = 64;

@Component({
  selector: 'app-flowchart',
  imports: [FFlowComponent, FFlowModule, InputNumberModule, CheckboxModule, InputTextModule, ContextMenuModule, Tooltip, SelectButtonModule, FormsModule, TranslateModule, Select, MultiSelect, DecimalPipe, ProgressSpinner, TableVisualizationPanel, PlanningOverlayComponent, TimingPanel, RobotSettingsModal, RunLogPanel],
  templateUrl: './flowchart.html',
  styleUrl: './flowchart.scss',
  providers: [FlowHistory],
  standalone: true,
})
export class Flowchart implements AfterViewChecked, AfterViewInit, OnDestroy, OnInit {
  readonly isDarkMode = signal<boolean>(readDarkMode());
  readonly nodes = signal<FlowNode[]>([]);
  readonly connections = signal<Connection[]>([]);
  readonly comments = signal<FlowComment[]>([]);
  readonly groups = signal<FlowGroup[]>([]);
  readonly isRunActive = signal(false);
  readonly debugState = signal<'idle' | 'running' | 'paused'>('idle');
  readonly breakpointInfo = signal<Record<string, unknown> | null>(null);
  readonly missionNodes = signal<FlowNode[]>([]);
  readonly missionConnections = signal<Connection[]>([]);
  readonly adHocNodes = signal<FlowNode[]>([]);
  readonly adHocConnections = signal<Connection[]>([]);
  readonly orientation = signal<FlowOrientation>('vertical');
  readonly contextMenu = new ContextMenuState();
  readonly lookups = new FlowchartLookupState();
  readonly layoutFlags: LayoutFlags = createLayoutFlags();
  readonly historyManager: FlowchartHistoryManager;
  readonly runManager: FlowchartRunManager;
  readonly typeDefinitionOptions = signal<DefinitionGroups>({});
  readonly typeDefinitions = signal<TypeDefinition[]>([]);
  readonly typeDefinitionsLoading = signal<boolean>(true);
  readonly viewToggleState = signal<Record<string, boolean>>(readStoredViewToggleState(DEFAULT_VIEW_TOGGLE_STATE));
  readonly viewToggleOptions = [
    { key: 'timestamps', labelKey: 'FLOWCHART.VIEW_TOGGLE_TIMESTAMPS', icon: 'pi pi-clock' },
    { key: 'tableVisualization', labelKey: 'FLOWCHART.VIEW_TOGGLE_TABLE_VIZ', icon: 'pi pi-map' },
    { key: 'logs', labelKey: 'FLOWCHART.VIEW_TOGGLE_LOGS', icon: 'pi pi-list' },
  ];
  readonly panelOffsets = signal<Record<FloatingPanelKey, PanelOffset>>({ ...DEFAULT_PANEL_OFFSETS });
  readonly selectedNodeIds = signal<Set<string>>(new Set());
  readonly selectionRect = signal<{ x: number; y: number; width: number; height: number } | null>(null);
  readonly selectionGroup = signal<FlowGroup | null>(null);
  readonly offscreenIndicator = signal<OffscreenIndicatorState>({ visible: false, x: 0, y: 0, angle: 0 });
  readonly selectionGroupId = '__selection__';
  readonly contextMenuOnPointerUp = true;
  readonly timingViewMode = signal<TimingViewMode>('list');
  readonly simulateRuns = signal<boolean>(true);
  readonly robotSettingsVisible = signal<boolean>(false);
  readonly robotSettingsInitialTab = signal<'project' | 'robot' | 'start' | 'map' | 'keybindings' | null>(null);
  readonly saveStatus = signal<'idle' | 'saving' | 'saved'>('idle');
  readonly logsFullscreen = signal<boolean>(false);
  viewportInitialized = false;
  private saveStatusTimeout?: ReturnType<typeof setTimeout>;
  actions!: FlowchartActions;
  readonly eMarkerType = EFMarkerType;
  orientationOptions: { label: string; value: FlowOrientation }[] = [];
  fCanvas = viewChild(FCanvasComponent);
  @ViewChildren('nodeElement') nodeEls!: QueryList<ElementRef<HTMLDivElement>>;
  @ViewChildren('commentTextarea') commentTextareas!: QueryList<ElementRef<HTMLTextAreaElement>>;
  @ViewChild('flowSurface') flowSurfaceRef!: ElementRef<HTMLDivElement>;
  @ViewChild('cm') cm!: ContextMenu;
  canUndoSignal?: Signal<boolean>;
  canRedoSignal?: Signal<boolean>;
  commentHeaderLabel = 'Comment';
  commentPlaceholder = 'Write a comment...';
  projectUUID: string | null = null;
  langChangeSub?: Subscription;
  themeObserver?: MutationObserver;
  typeDefinitionsSub?: Subscription;
  simulationPathSub?: Subscription;
  private stepsSub?: Subscription;
  private missionListSub?: Subscription;
  private missionDetailSub?: Subscription;
  private _useAutoLayout = readStoredAutoLayout();
  private activePanelDrag: PanelDragState | null = null;
  private deviceInfo: ConnectionInfo | null = null;
  private loadingDeviceInfo = false;
  private libstpIndexTriggered = false;
  private projectSimulationCache: ProjectSimulationData | null = null;
  private plannedPathUpdateTimeout?: ReturnType<typeof setTimeout>;
  private robotSettingsWasOpen = false;
  private panelResizeObserver?: ResizeObserver;
  private pendingPanelClamp = false;
  private selectionDrag:
    | { startX: number; startY: number; surfaceRect: DOMRect; moved: boolean }
    | null = null;
  private offscreenIndicatorFrame: number | null = null;
  private liveCanvasTrackingFrame: number | null = null;
  private liveCanvasTrackingActive = false;
  private recenterTrackingTimeout?: ReturnType<typeof setTimeout>;
  private suppressContextMenuOnce = false;
  private suppressContextMenuTimeout?: ReturnType<typeof setTimeout>;
  private readonly multiSensorSelectionCache = new Map<string, string[]>();
  multiDragStartPositions: Map<string, { x: number; y: number }> | null = null;
  private multiDragPointerUpBound = () => this.stopMultiDrag();
  private rightDragState: { startX: number; startY: number; moved: boolean } | null = null;
  private rightDragPointerMoveBound = (event: PointerEvent) => this.onRightPointerMove(event);
  private rightDragPointerUpBound = () => this.onRightPointerUp();
  private lastRightDown: { x: number; y: number } | null = null;

  constructor(
    readonly missionState: MissionStateService,
    readonly stepsState: StepsStateService,
    readonly http: HttpService,
    readonly route: ActivatedRoute,
    readonly history: FlowHistory,
    readonly translate: TranslateService,
    readonly tableViz: TableVisualizationService,
    readonly tableMap: TableMapService,
    readonly planningService: PlanningModeService,
    readonly keybindingsService: KeybindingsService
  ) {
    this.historyManager = createHistoryManager(this);
    this.runManager = createRunManager(this);
    this.actions = createFlowchartActions(this);
    initializeFlowchart(this);

    effect(() => {
      const isOpen = this.robotSettingsVisible();
      if (this.robotSettingsWasOpen && !isOpen) {
        this.refreshPlannedPathAfterRobotSettings();
      }
      this.robotSettingsWasOpen = isOpen;
    });

    effect(() => {
      this.actions.visibleNodes();
      this.groups();
      this.comments();
      this.orientation();
      this.selectionGroup();

      if (this.planningService.isActive() || this.logsFullscreen()) {
        this.hideOffscreenIndicator();
        return;
      }

      this.scheduleOffscreenIndicatorUpdate();
    });
  }

  ngOnInit(): void {
    this.loadTypeDefinitions();
    this.preloadMissionAndSteps();
  }

  get useAutoLayout(): boolean {
    return this._useAutoLayout;
  }

  set useAutoLayout(value: boolean) {
    if (this._useAutoLayout === value) return;
    this._useAutoLayout = value;
    persistAutoLayout(value);
    if (value) {
      this.layoutFlags.needsAdjust = true;
      this.layoutFlags.pendingViewportReset = true;
    } else {
      recomputeMergedView(this);
    }
  }

  ngAfterViewChecked(): void {
    handleAfterViewChecked(this);
  }

  ngAfterViewInit(): void {
    const surface = this.flowSurfaceRef?.nativeElement;
    if (!surface || typeof ResizeObserver === 'undefined') return;
    this.panelResizeObserver = new ResizeObserver(() => this.schedulePanelClamp());
    this.panelResizeObserver.observe(surface);
    this.schedulePanelClamp();
    this.scheduleOffscreenIndicatorUpdate();
  }

  ngOnDestroy(): void {
    this.actions.stopRun();
    this.stopPanelDrag();
    this.stopSelectionDrag();
    this.langChangeSub?.unsubscribe();
    this.themeObserver?.disconnect();
    this.typeDefinitionsSub?.unsubscribe();
    this.simulationPathSub?.unsubscribe();
    this.stepsSub?.unsubscribe();
    this.missionListSub?.unsubscribe();
    this.missionDetailSub?.unsubscribe();
    if (this.saveStatusTimeout) {
      clearTimeout(this.saveStatusTimeout);
    }
    this.panelResizeObserver?.disconnect();
    this.stopMultiDrag();
    if (this.suppressContextMenuTimeout) {
      clearTimeout(this.suppressContextMenuTimeout);
    }
    if (this.plannedPathUpdateTimeout) {
      clearTimeout(this.plannedPathUpdateTimeout);
      this.plannedPathUpdateTimeout = undefined;
    }
    if (this.offscreenIndicatorFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.offscreenIndicatorFrame);
      this.offscreenIndicatorFrame = null;
    }
    if (this.recenterTrackingTimeout) {
      clearTimeout(this.recenterTrackingTimeout);
      this.recenterTrackingTimeout = undefined;
    }
    this.stopLiveCanvasTracking();
    this.stopRightDrag();
  }

  @HostListener('window:pointerdown', ['$event'])
  onWindowPointerDown(event: PointerEvent): void {
    if (event.button !== 2) return;
    const surface = this.flowSurfaceRef?.nativeElement;
    if (!surface || !surface.contains(event.target as Node)) return;
    this.lastRightDown = { x: event.clientX, y: event.clientY };
    this.startRightDrag(event);
  }

  @HostListener('window:pointerup')
  @HostListener('window:pointercancel')
  onWindowPointerRelease(): void {
    this.stopLiveCanvasTracking();
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    // Skip if inside input, textarea, or contenteditable
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    // Skip if planning mode is active
    if (this.planningService.isActive()) {
      return;
    }

    // Skip if settings modal is open
    if (this.robotSettingsVisible()) {
      return;
    }

    // Delete key - delete selected node(s)
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.selectedNodeIds().size > 0 || this.contextMenu.selectedNodeId) {
        event.preventDefault();
        this.actions.deleteNode();
        return;
      }
    }

    // Ctrl+Z - Undo
    if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.actions.undo();
      return;
    }

    // Ctrl+Shift+Z or Ctrl+Y - Redo
    if ((event.ctrlKey || event.metaKey) && (event.key === 'Z' || event.key === 'y')) {
      event.preventDefault();
      this.actions.redo();
      return;
    }

    // Ctrl+S - Save
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      this.actions.onSave();
      return;
    }

    // Ctrl+K - Open settings with keybindings tab
    if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
      event.preventDefault();
      this.openKeybindingsSettings();
      return;
    }

    // Check for custom step keybindings
    const keybind = this.keybindingsService.parseKeyEvent(event);
    const stepBinding = this.keybindingsService.getStepForKeybinding(keybind);
    if (stepBinding) {
      const steps = this.stepsState.currentSteps();
      const step = steps?.find(
        s => s.name === stepBinding.stepName &&
             (s.import ?? null) === stepBinding.stepImport &&
             s.file === stepBinding.stepFile
      );
      if (step) {
        event.preventDefault();
        this.createNodeFromStep(step);
        return;
      }
    }
  }

  createNodeFromStep(step: Step): void {
    const args: Record<string, boolean | string | number | null> = {};
    step?.arguments?.forEach(arg => {
      args[arg.name] = toVal(arg.type, arg.default ?? '');
    });

    // Get canvas center for node placement
    const canvas = this.fCanvas();
    const position = canvas
      ? { x: -canvas.transform.position.x + 200, y: -canvas.transform.position.y + 200 }
      : { x: 200, y: 200 };

    this.adHocNodes.set([
      ...this.adHocNodes(),
      {
        id: generateGuid(),
        text: step?.name ?? this.translate.instant('FLOWCHART.NEW_NODE'),
        position,
        step,
        args,
      },
    ]);
    recomputeMergedView(this);
    this.layoutFlags.needsAdjust = true;
    this.historyManager.recordHistory('create-node');
    this.keybindingsService.trackStepUsage(step);
  }

  openKeybindingsSettings(): void {
    this.robotSettingsInitialTab.set('keybindings');
    this.robotSettingsVisible.set(true);
  }

  onCanvasChange(): void {
    this.scheduleOffscreenIndicatorUpdate();
  }

  recenterFlowchart(): void {
    this.startLiveCanvasTracking();
    this.fCanvas()?.resetScaleAndCenter(true);
    this.scheduleOffscreenIndicatorUpdate();
    if (this.recenterTrackingTimeout) {
      clearTimeout(this.recenterTrackingTimeout);
    }
    this.recenterTrackingTimeout = setTimeout(() => {
      this.recenterTrackingTimeout = undefined;
      this.stopLiveCanvasTracking();
      this.scheduleOffscreenIndicatorUpdate();
    }, 500);
  }

  onSurfacePointerUp(event: PointerEvent): void {
    if (event.button !== 2 || !this.contextMenuOnPointerUp) return;
    const start = this.lastRightDown;
    this.lastRightDown = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.hypot(dx, dy) > 4) {
      return;
    }
    this.showContextMenuForPoint(event.clientX, event.clientY);
  }

  setSaveStatus(status: 'idle' | 'saving' | 'saved'): void {
    if (this.saveStatusTimeout) {
      clearTimeout(this.saveStatusTimeout);
      this.saveStatusTimeout = undefined;
    }
    this.saveStatus.set(status);
    if (status === 'saved') {
      this.saveStatusTimeout = setTimeout(() => {
        this.saveStatus.set('idle');
      }, 2000);
    }
  }

  private loadTypeDefinitions(): void {
    this.typeDefinitionsSub?.unsubscribe();
    const projectUUID = this.projectUUID;
    if (!projectUUID) {
      this.typeDefinitionOptions.set({});
      this.typeDefinitions.set([]);
      this.typeDefinitionsLoading.set(false);
      return;
    }
    this.typeDefinitionsLoading.set(true);
    this.typeDefinitionsSub = this.http.getTypeDefinitions(projectUUID).subscribe({
      next: defs => {
        this.typeDefinitions.set(defs);
        this.typeDefinitionOptions.set(this.groupDefinitionsByType(defs));
        this.typeDefinitionsLoading.set(false);
        if (this.deviceInfo) {
          this.applyDeviceVisualizationInfo(this.deviceInfo);
        }
      },
      error: () => {
        this.typeDefinitions.set([]);
        this.typeDefinitionOptions.set({});
        this.typeDefinitionsLoading.set(false);
      },
    });
  }

  private scheduleOffscreenIndicatorUpdate(): void {
    if (this.offscreenIndicatorFrame !== null) {
      return;
    }
    if (typeof requestAnimationFrame !== 'function') {
      this.updateOffscreenIndicator();
      return;
    }
    this.offscreenIndicatorFrame = requestAnimationFrame(() => {
      this.offscreenIndicatorFrame = null;
      this.updateOffscreenIndicator();
    });
  }

  private startLiveCanvasTracking(): void {
    if (this.liveCanvasTrackingActive) {
      return;
    }
    this.liveCanvasTrackingActive = true;
    this.scheduleLiveCanvasTrackingFrame();
  }

  private scheduleLiveCanvasTrackingFrame(): void {
    if (!this.liveCanvasTrackingActive || this.liveCanvasTrackingFrame !== null) {
      return;
    }
    if (typeof requestAnimationFrame !== 'function') {
      this.scheduleOffscreenIndicatorUpdate();
      return;
    }
    this.liveCanvasTrackingFrame = requestAnimationFrame(() => {
      this.liveCanvasTrackingFrame = null;
      if (!this.liveCanvasTrackingActive) {
        return;
      }
      this.scheduleOffscreenIndicatorUpdate();
      this.scheduleLiveCanvasTrackingFrame();
    });
  }

  private stopLiveCanvasTracking(): void {
    this.liveCanvasTrackingActive = false;
    if (this.liveCanvasTrackingFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.liveCanvasTrackingFrame);
      this.liveCanvasTrackingFrame = null;
    }
  }

  private updateOffscreenIndicator(): void {
    if (this.planningService.isActive() || this.logsFullscreen()) {
      this.hideOffscreenIndicator();
      return;
    }

    const surface = this.flowSurfaceRef?.nativeElement;
    if (!surface) {
      this.hideOffscreenIndicator();
      return;
    }

    const width = surface.clientWidth;
    const height = surface.clientHeight;
    if (!width || !height) {
      this.hideOffscreenIndicator();
      return;
    }

    const renderedBounds = this.getRenderedFlowchartBounds(surface);
    if (!renderedBounds) {
      this.hideOffscreenIndicator();
      return;
    }

    const screenBounds = {
      left: renderedBounds.left - OFFSCREEN_INDICATOR_BOUNDS_PADDING_PX,
      right: renderedBounds.right + OFFSCREEN_INDICATOR_BOUNDS_PADDING_PX,
      top: renderedBounds.top - OFFSCREEN_INDICATOR_BOUNDS_PADDING_PX,
      bottom: renderedBounds.bottom + OFFSCREEN_INDICATOR_BOUNDS_PADDING_PX,
    };

    const centerX = width / 2;
    const centerY = height / 2;
    const targetX = clamp(centerX, screenBounds.left, screenBounds.right);
    const targetY = clamp(centerY, screenBounds.top, screenBounds.bottom);
    const dx = targetX - centerX;
    const dy = targetY - centerY;
    if (Math.abs(dx) < OFFSCREEN_INDICATOR_HORIZONTAL_THRESHOLD_PX
      && Math.abs(dy) < OFFSCREEN_INDICATOR_VERTICAL_THRESHOLD_PX) {
      this.hideOffscreenIndicator();
      return;
    }

    const edgeX = width / 2 - OFFSCREEN_INDICATOR_EDGE_PADDING_PX;
    const edgeY = height / 2 - OFFSCREEN_INDICATOR_EDGE_PADDING_PX;
    const travel = Math.min(
      dx === 0 ? Number.POSITIVE_INFINITY : edgeX / Math.abs(dx),
      dy === 0 ? Number.POSITIVE_INFINITY : edgeY / Math.abs(dy),
    );

    this.offscreenIndicator.set({
      visible: true,
      x: centerX + dx * travel,
      y: centerY + dy * travel,
      angle: Math.atan2(dy, dx) * (180 / Math.PI),
    });
  }

  private getRenderedFlowchartBounds(surface: HTMLElement): { left: number; right: number; top: number; bottom: number } | null {
    const surfaceRect = surface.getBoundingClientRect();
    const elements = Array.from(
      surface.querySelectorAll<HTMLElement>('.node[data-node-id], .comment-node, .group-node:not(.selection-group)')
    );

    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;

    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        continue;
      }
      left = Math.min(left, rect.left - surfaceRect.left);
      right = Math.max(right, rect.right - surfaceRect.left);
      top = Math.min(top, rect.top - surfaceRect.top);
      bottom = Math.max(bottom, rect.bottom - surfaceRect.top);
    }

    if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top) || !Number.isFinite(bottom)) {
      return null;
    }

    return { left, right, top, bottom };
  }

  private hideOffscreenIndicator(): void {
    if (!this.offscreenIndicator().visible) {
      return;
    }
    this.offscreenIndicator.set({ visible: false, x: 0, y: 0, angle: 0 });
  }

  private preloadMissionAndSteps(): void {
    const projectUUID = this.projectUUID;
    if (!projectUUID) return;

    try {
      this.stepsSub?.unsubscribe();
      this.stepsSub = this.http.getAllSteps(projectUUID).subscribe({
        next: steps => {
          this.stepsState.setSteps(steps);
        },
        error: () => {
          this.stepsState.setSteps([]);
        },
      });
    } catch {
      this.stepsState.setSteps([]);
    }

    try {
      this.missionListSub?.unsubscribe();
      this.missionListSub = this.http.getAllMissions(projectUUID).subscribe({
        next: missions => {
          if (this.missionState.currentMission()) {
            return;
          }
          const first = missions[0];
          if (!first) {
            this.missionState.setMission(null);
            return;
          }
          this.missionDetailSub?.unsubscribe();
          this.missionDetailSub = this.http.getDetailedMission(projectUUID, first.name).subscribe({
            next: mission => {
              if (!this.missionState.currentMission()) {
                this.missionState.setMission(mission);
              }
            },
            error: () => {
              if (!this.missionState.currentMission()) {
                this.missionState.setMission(null);
              }
            },
          });
        },
        error: () => {
          if (!this.missionState.currentMission()) {
            this.missionState.setMission(null);
          }
        },
      });
    } catch {
      if (!this.missionState.currentMission()) {
        this.missionState.setMission(null);
      }
    }
  }

  isToggleEnabled(key: string): boolean {
    return this.viewToggleState()[key];
  }

  toggleViewOption(key: string): void {
    this.viewToggleState.update(prev => {
      const next = { ...prev, [key]: !prev[key] };
      persistViewToggleState(next);
      if (key === 'logs' && !next['logs']) {
        this.logsFullscreen.set(false);
      }
      return next;
    });
  }

  setLogsFullscreen(value: boolean): void {
    this.logsFullscreen.set(value);
  }

  setTimingViewMode(mode: TimingViewMode): void {
    this.timingViewMode.set(mode);
  }

  toggleSimulation(): void {
    this.simulateRuns.update(prev => !prev);
  }

  schedulePlannedPathUpdate(mission: Mission | null): void {
    if (this.plannedPathUpdateTimeout) {
      clearTimeout(this.plannedPathUpdateTimeout);
    }
    this.plannedPathUpdateTimeout = setTimeout(() => {
      this.plannedPathUpdateTimeout = undefined;
      this.updatePlannedPathForMission(mission);
    }, 0);
  }

  invalidateProjectSimulationCache(): void {
    this.projectSimulationCache = null;
  }

  updatePlannedPathForMission(mission: Mission | null): void {
    this.simulationPathSub?.unsubscribe();
    this.simulationPathSub = undefined;

    if (!mission || !this.projectUUID) {
      this.tableViz.setPlannedPathLoading(false);
      this.tableViz.setPlannedPath(null);
      this.tableViz.setPlannedMissionEndIndices(null);
      this.tableViz.setPlannedHighlightRange(null);
      return;
    }

    this.tableViz.setPlannedPathLoading(true);
    this.loadDeviceVisualizationInfo();

    const cachedSimulation = this.projectSimulationCache;
    if (cachedSimulation) {
      this.applyPlannedPathFromSimulation(mission, cachedSimulation);
      this.simulationPathSub = this.http.getMissionSimulationData(this.projectUUID, mission.name).subscribe({
        next: data => {
          const merged = this.mergeMissionSimulation(cachedSimulation, data);
          if (!merged) {
            this.fetchProjectSimulationData(mission);
            return;
          }
          this.projectSimulationCache = merged;
          this.applyPlannedPathFromSimulation(mission, merged);
          this.tableViz.setPlannedPathLoading(false);
        },
        error: err => {
          console.warn('[Flowchart] Failed to load mission simulation data', err);
          this.tableViz.setPlannedPathLoading(false);
        },
      });
      return;
    }

    this.fetchProjectSimulationData(mission);
  }

  private fetchProjectSimulationData(mission: Mission): void {
    if (!this.projectUUID) return;
    this.simulationPathSub?.unsubscribe();
    this.simulationPathSub = this.http.getProjectSimulationData(this.projectUUID).subscribe({
      next: data => {
        this.projectSimulationCache = data;
        this.applyPlannedPathFromSimulation(mission, data);
        this.tableViz.setPlannedPathLoading(false);
      },
      error: err => {
        console.warn('[Flowchart] Failed to load simulation data', err);
        this.tableViz.setPlannedPath(null);
        this.tableViz.setPlannedMissionEndIndices(null);
        this.tableViz.setPlannedHighlightRange(null);
        this.tableViz.setPlannedPathLoading(false);
      },
    });
  }

  private applyPlannedPathFromSimulation(mission: Mission, data: ProjectSimulationData): void {
    const startPose = this.tableViz.startPose();
    const robotConfig = this.tableViz.robotConfig();
    const sensorConfig = this.tableViz.sensorConfig();
    const mapConfig = this.tableMap.config();
    const hasLineupContext = this.tableMap.isLoaded() && sensorConfig.lineSensors.length >= 2;
    const lineupContext = hasLineupContext
      ? {
          isOnBlackLine: (xCm: number, yCm: number) => this.tableMap.isOnBlackLine(xCm, yCm),
          lineSensors: sensorConfig.lineSensors,
          rotationCenterForwardCm: robotConfig.rotationCenterForwardCm,
          rotationCenterStrafeCm: robotConfig.rotationCenterStrafeCm,
          maxDistanceCm: Math.max(mapConfig.widthCm, mapConfig.heightCm),
        }
      : null;
    const planned = this.historyManager.hasUnsavedChanges()
      ? buildPlannedPathFromProjectSimulationWithMissionOverride(startPose, data, mission, { lineup: lineupContext })
      : buildPlannedPathFromProjectSimulation(startPose, data, { lineup: lineupContext });
    const highlightRange = planned.missionRanges.find(range => range.name === mission.name) ?? null;
    this.tableViz.setPlannedPath(planned.poses.length > 1 ? planned.poses : null);
    this.tableViz.setPlannedMissionEndIndices(planned.missionEndIndices.length ? planned.missionEndIndices : null);
    this.tableViz.setPlannedHighlightRange(
      highlightRange ? { startIndex: highlightRange.startIndex, endIndex: highlightRange.endIndex } : null
    );
  }

  private mergeMissionSimulation(
    cache: ProjectSimulationData,
    missionData: MissionSimulationData
  ): ProjectSimulationData | null {
    const missions = [...(cache.missions ?? [])];
    const idx = missions.findIndex(m => m.name === missionData.name);
    if (idx === -1) {
      return null;
    }
    missions[idx] = missionData;
    return { missions };
  }

  private refreshPlannedPathAfterRobotSettings(): void {
    const mission = this.missionState.currentMission();
    if (!mission) {
      return;
    }
    if (this.projectSimulationCache) {
      this.applyPlannedPathFromSimulation(mission, this.projectSimulationCache);
      return;
    }
    this.updatePlannedPathForMission(mission);
  }

  private loadDeviceVisualizationInfo(): void {
    if (this.deviceInfo || this.loadingDeviceInfo) return;
    this.loadingDeviceInfo = true;
    try {
      this.http.getDeviceInfoDefault().subscribe({
        next: info => {
          this.deviceInfo = info;
          this.loadingDeviceInfo = false;
          this.refreshDeviceStepIndexCache();
          this.applyDeviceVisualizationInfo(info);
        },
        error: () => {
          this.loadingDeviceInfo = false;
        },
      });
    } catch {
      this.loadingDeviceInfo = false;
    }
  }

  private refreshDeviceStepIndexCache() {
    if (this.libstpIndexTriggered) {
      return;
    }
    this.libstpIndexTriggered = true;
    this.http.getDeviceSteps().subscribe({
      next: steps => {
        this.http.importStepIndex(steps).subscribe({
          next: () => {
            this.refreshLocalSteps();
            this.libstpIndexTriggered = false;
          },
          error: () => {
            this.libstpIndexTriggered = false;
          },
        });
      },
      error: () => {
        this.libstpIndexTriggered = false;
      },
    });
  }

  private refreshLocalSteps(): void {
    const projectUUID = this.projectUUID;
    if (!projectUUID) return;
    try {
      this.stepsSub?.unsubscribe();
      this.stepsSub = this.http.getAllSteps(projectUUID).subscribe({
        next: steps => {
          this.stepsState.setSteps(steps);
        },
        error: () => {
          this.stepsState.setSteps([]);
        },
      });
    } catch {
      this.stepsState.setSteps([]);
    }
  }

  private applyDeviceVisualizationInfo(info: ConnectionInfo): void {
    const isPositiveNumber = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0;
    const fallback = this.tableViz.robotConfig();
    const fallbackWidth = isPositiveNumber(fallback.widthCm) ? fallback.widthCm : 15;
    const fallbackLength = isPositiveNumber(fallback.lengthCm) ? fallback.lengthCm : 22;
    const width = isPositiveNumber(info.width_cm) ? info.width_cm : fallbackWidth;
    const length = isPositiveNumber(info.length_cm) ? info.length_cm : fallbackLength;
    if (isPositiveNumber(info.width_cm) && isPositiveNumber(info.length_cm)) {
      this.tableViz.setRobotDimensions(info.width_cm, info.length_cm);
    } else if (!isPositiveNumber(fallback.widthCm) || !isPositiveNumber(fallback.lengthCm)) {
      this.tableViz.setRobotDimensions(fallbackWidth, fallbackLength);
    }

    // Rotation center is stored in cm from lower-left origin
    if (info.rotation_center && isPositiveNumber(width) && isPositiveNumber(length)) {
      const forwardCm = info.rotation_center.y_cm - length / 2;
      const strafeCm = (width / 2) - info.rotation_center.x_cm;
      this.tableViz.setRotationCenter(forwardCm, strafeCm);
    }

    const sensors = info.sensors ?? [];
    const definitions = this.typeDefinitions();
    const irDefs = definitions.filter(d => d.type === 'IRSensor');
    const sensorLookup = new Map(sensors.map(sensor => [sensor.name, sensor]));
    const orderedSensors = irDefs.length
      ? irDefs.map(def => sensorLookup.get(def.name)).filter((s): s is DeviceSensorInfo => !!s)
      : sensors;

    this.tableViz.clearSensors();
    if (!isPositiveNumber(width) || !isPositiveNumber(length)) return;
    // Sensors are stored in cm from lower-left origin
    orderedSensors.forEach((sensor, index) => {
      if (sensor.x_cm === undefined || sensor.y_cm === undefined) return;
      const forwardCm = sensor.y_cm - length / 2;
      const strafeCm = (width / 2) - sensor.x_cm;
      this.tableViz.configureLineSensor(index, forwardCm, strafeCm);
    });
  }

  openRobotSettings(): void {
    this.robotSettingsVisible.set(true);
  }

  isNodeSelected(nodeId: string): boolean {
    return this.selectedNodeIds().has(nodeId);
  }

  private isSyntheticJunctionNodeId(nodeId: string): boolean {
    return nodeId.startsWith('junction-');
  }

  clearNodeSelection(): void {
    if (this.selectedNodeIds().size) {
      this.selectedNodeIds.set(new Set());
    }
    this.selectionGroup.set(null);
  }

  onNodePointerDown(event: PointerEvent, nodeId: string): void {
    if (!event.isPrimary || event.button !== 0) return;
    if (this.isSyntheticJunctionNodeId(nodeId)) return;
    const current = this.selectedNodeIds();
    if (current.size > 1) {
      this.selectedNodeIds.set(new Set([nodeId]));
      this.selectionGroup.set(null);
      return;
    }
    if (!current.has(nodeId)) {
      this.selectedNodeIds.set(new Set([nodeId]));
      this.selectionGroup.set(null);
      return;
    }
  }

  onSurfacePointerDown(event: PointerEvent): void {
    this.startLiveCanvasTracking();
    if (!event.isPrimary || event.button !== 2) return;
    if (!this.flowSurfaceRef?.nativeElement) return;
    this.stopSelectionDrag();
    const surfaceRect = this.flowSurfaceRef.nativeElement.getBoundingClientRect();
    this.selectionDrag = {
      startX: event.clientX,
      startY: event.clientY,
      surfaceRect,
      moved: false,
    };
    window.addEventListener('pointermove', this.onSelectionPointerMove);
    window.addEventListener('pointerup', this.onSelectionPointerUp);
  }

  onCanvasContextMenu(event: MouseEvent): void {
    if (this.contextMenuOnPointerUp) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (this.shouldSuppressContextMenu(event) || this.consumeContextMenuSuppression()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    this.actions.onCanvasContextMenu(event);
  }

  consumeContextMenuSuppression(): boolean {
    if (!this.suppressContextMenuOnce) return false;
    this.suppressContextMenuOnce = false;
    return true;
  }

  shouldSuppressContextMenu(event: MouseEvent): boolean {
    const start = this.lastRightDown;
    this.lastRightDown = null;
    if (!start) return false;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    return Math.hypot(dx, dy) > 4;
  }

  panelTransform(key: FloatingPanelKey): string {
    const offset = this.panelOffsets()[key];
    return `translate3d(${offset.x}px, ${offset.y}px, 0)`;
  }

  startPanelDrag(event: PointerEvent, key: FloatingPanelKey): void {
    if (!event.isPrimary || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.panel-drag-handle')) return;
    if (target.closest('button, input, textarea, select, option, a, [data-no-drag]')) return;
    const panelEl = event.currentTarget as HTMLElement | null;
    const surfaceEl = this.flowSurfaceRef?.nativeElement;
    if (!panelEl || !surfaceEl) return;

    event.preventDefault();
    event.stopPropagation();

    this.stopPanelDrag();
    const offset = this.panelOffsets()[key];
    this.activePanelDrag = {
      key,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
      startRect: panelEl.getBoundingClientRect(),
      surfaceRect: surfaceEl.getBoundingClientRect(),
    };
    window.addEventListener('pointermove', this.onPanelPointerMove);
    window.addEventListener('pointerup', this.onPanelPointerUp);
  }

  private onPanelPointerMove = (event: PointerEvent): void => {
    const drag = this.activePanelDrag;
    if (!drag) return;
    event.preventDefault();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const minDx = drag.surfaceRect.left - drag.startRect.left;
    const maxDx = drag.surfaceRect.right - drag.startRect.right;
    const minDy = drag.surfaceRect.top - drag.startRect.top;
    const maxDy = drag.surfaceRect.bottom - drag.startRect.bottom;
    const clampedDx = this.clamp(dx, minDx, maxDx);
    const clampedDy = this.clamp(dy, minDy, maxDy);

    this.panelOffsets.update(prev => ({
      ...prev,
      [drag.key]: { x: drag.originX + clampedDx, y: drag.originY + clampedDy },
    }));
  };

  private onPanelPointerUp = (): void => {
    this.stopPanelDrag();
  };

  private stopPanelDrag(): void {
    if (!this.activePanelDrag) return;
    this.activePanelDrag = null;
    window.removeEventListener('pointermove', this.onPanelPointerMove);
    window.removeEventListener('pointerup', this.onPanelPointerUp);
  }

  private clamp(value: number, min: number, max: number): number {
    if (min > max) {
      const tmp = min;
      min = max;
      max = tmp;
    }
    return Math.min(Math.max(value, min), max);
  }

  private schedulePanelClamp(): void {
    if (this.pendingPanelClamp) return;
    this.pendingPanelClamp = true;
    requestAnimationFrame(() => {
      this.pendingPanelClamp = false;
      this.clampPanelsToSurface();
    });
  }

  private clampPanelsToSurface(): void {
    const surface = this.flowSurfaceRef?.nativeElement;
    if (!surface) return;
    const surfaceRect = surface.getBoundingClientRect();
    const offsets = this.panelOffsets();
    let changed = false;
    const next: Record<FloatingPanelKey, PanelOffset> = { ...offsets };
    (Object.keys(offsets) as FloatingPanelKey[]).forEach(key => {
      const panelEl = surface.querySelector<HTMLElement>(`[data-panel-key="${key}"]`);
      if (!panelEl || panelEl.classList.contains('is-hidden')) return;
      const rect = panelEl.getBoundingClientRect();
      let dx = 0;
      let dy = 0;
      if (rect.left < surfaceRect.left) {
        dx = surfaceRect.left - rect.left;
      } else if (rect.right > surfaceRect.right) {
        dx = surfaceRect.right - rect.right;
      }
      if (rect.top < surfaceRect.top) {
        dy = surfaceRect.top - rect.top;
      } else if (rect.bottom > surfaceRect.bottom) {
        dy = surfaceRect.bottom - rect.bottom;
      }
      if (dx || dy) {
        next[key] = { x: offsets[key].x + dx, y: offsets[key].y + dy };
        changed = true;
      }
    });
    if (changed) {
      this.panelOffsets.set(next);
    }
  }

  private onSelectionPointerMove = (event: PointerEvent): void => {
    const drag = this.selectionDrag;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) {
      return;
    }
    if (!drag.moved) {
      drag.moved = true;
      this.scheduleContextMenuSuppression();
    }
    const minX = Math.min(drag.startX, event.clientX);
    const maxX = Math.max(drag.startX, event.clientX);
    const minY = Math.min(drag.startY, event.clientY);
    const maxY = Math.max(drag.startY, event.clientY);
    this.selectionRect.set({
      x: minX - drag.surfaceRect.left,
      y: minY - drag.surfaceRect.top,
      width: maxX - minX,
      height: maxY - minY,
    });
    this.updateSelectedNodesFromRect(minX, minY, maxX, maxY);
  };

  private onSelectionPointerUp = (): void => {
    if (!this.selectionDrag) return;
    if (this.selectionDrag.moved) {
      this.scheduleContextMenuSuppression();
    }
    this.selectionRect.set(null);
    this.stopSelectionDrag();
  };

  private stopSelectionDrag(): void {
    if (!this.selectionDrag) return;
    this.selectionDrag = null;
    window.removeEventListener('pointermove', this.onSelectionPointerMove);
    window.removeEventListener('pointerup', this.onSelectionPointerUp);
  }

  private scheduleContextMenuSuppression(): void {
    this.suppressContextMenuOnce = true;
    if (this.suppressContextMenuTimeout) {
      clearTimeout(this.suppressContextMenuTimeout);
    }
    this.suppressContextMenuTimeout = setTimeout(() => {
      this.suppressContextMenuOnce = false;
      this.suppressContextMenuTimeout = undefined;
    }, 400);
  }

  private startRightDrag(event: PointerEvent): void {
    this.stopRightDrag();
    this.rightDragState = { startX: event.clientX, startY: event.clientY, moved: false };
    window.addEventListener('pointermove', this.rightDragPointerMoveBound);
    window.addEventListener('pointerup', this.rightDragPointerUpBound);
    window.addEventListener('pointercancel', this.rightDragPointerUpBound);
  }

  private onRightPointerMove(event: PointerEvent): void {
    const state = this.rightDragState;
    if (!state) return;
    if ((event.buttons & 2) !== 2) return;
    if (state.moved) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (Math.hypot(dx, dy) >= 4) {
      state.moved = true;
      this.scheduleContextMenuSuppression();
    }
  }

  private onRightPointerUp(): void {
    const state = this.rightDragState;
    if (state?.moved) {
      this.scheduleContextMenuSuppression();
    }
    this.stopRightDrag();
  }

  private stopRightDrag(): void {
    if (!this.rightDragState) return;
    this.rightDragState = null;
    window.removeEventListener('pointermove', this.rightDragPointerMoveBound);
    window.removeEventListener('pointerup', this.rightDragPointerUpBound);
    window.removeEventListener('pointercancel', this.rightDragPointerUpBound);
  }

  private showContextMenuForPoint(clientX: number, clientY: number): void {
    const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (target?.closest('.comment-text')) {
      return;
    }
    const commentEl = target?.closest<HTMLElement>('.comment-node');
    const commentId = commentEl?.getAttribute('data-comment-id');
    if (commentId) {
      this.contextMenu.selectComment(commentId, { clientX, clientY });
      this.contextMenu.setItems(this.contextMenu.commentItems);
      this.cm.show(this.buildContextEvent(clientX, clientY));
      return;
    }
    const nodeEl = target?.closest<HTMLElement>('.node[data-node-id]');
    const nodeId = nodeEl?.getAttribute('data-node-id');
    if (nodeId && nodeId !== 'start-node' && !this.isSyntheticJunctionNodeId(nodeId)) {
      if (!this.selectedNodeIds().has(nodeId)) {
        this.selectedNodeIds.set(new Set([nodeId]));
      }
      this.contextMenu.selectNode(nodeId, { clientX, clientY });
      const parentId = this.actions.getNodeParentId(nodeId);
      const items: MenuItem[] = [];
      if (parentId) {
        const removeItem = this.contextMenu.nodeItems.find(item => item.label === this.translate.instant('FLOWCHART.REMOVE_FROM_GROUP'));
        if (removeItem) items.push(removeItem);
      }
      const deleteLabel = this.translate.instant('COMMON.DELETE');
      items.push({
        label: deleteLabel,
        icon: 'pi pi-trash',
        command: () => this.actions.deleteNode(),
      });
      this.contextMenu.setItems(items);
      this.cm.show(this.buildContextEvent(clientX, clientY));
      return;
    }
    const groupEl = target?.closest<HTMLElement>('.group-node');
    const groupId = groupEl?.getAttribute('data-group-id');
    if (groupId === this.selectionGroupId) {
      const deleteLabel = this.translate.instant('COMMON.DELETE');
      this.contextMenu.setItems([{
        label: deleteLabel,
        icon: 'pi pi-trash',
        command: () => this.actions.deleteNode(),
      }]);
      this.cm.show(this.buildContextEvent(clientX, clientY));
      return;
    }
    if (groupId) {
      this.contextMenu.selectGroup(groupId, { clientX, clientY });
      this.contextMenu.setItems(this.contextMenu.groupItems);
      this.cm.show(this.buildContextEvent(clientX, clientY));
      return;
    }
    const connectionId = this.findNearbyConnection(clientX, clientY);
    if (connectionId) {
      this.contextMenu.selectConnection(connectionId, { clientX, clientY });
      const isMissionConnection = this.missionConnections().some(c => c.id === connectionId);
      const connection = this.connections().find(c => c.id === connectionId);
      const [addItem, removeItem] = this.contextMenu.connectionItems;
      const menu: MenuItem[] = [];
      if (addItem) {
        menu.push({
          ...addItem,
          disabled: !isMissionConnection || !!connection?.hasBreakpoint,
        });
      }
      if (removeItem) {
        menu.push({
          ...removeItem,
          disabled: !isMissionConnection || !connection?.hasBreakpoint,
        });
      }
      this.contextMenu.setItems(menu);
      this.cm.show(this.buildContextEvent(clientX, clientY));
      return;
    }
    this.contextMenu.eventPosition = { clientX, clientY };
    this.contextMenu.setItems(this.contextMenu.canvasItems);
    this.cm.show(this.buildContextEvent(clientX, clientY));
  }

  private findNearbyConnection(clientX: number, clientY: number): string | null {
    const offsets = [
      { dx: 0, dy: 0 },
      { dx: 16, dy: 0 },
      { dx: -16, dy: 0 },
      { dx: 0, dy: 16 },
      { dx: 0, dy: -16 },
      { dx: 16, dy: 16 },
      { dx: -16, dy: 16 },
      { dx: 16, dy: -16 },
      { dx: -16, dy: -16 },
    ];
    for (const offset of offsets) {
      const candidate = document.elementFromPoint(clientX + offset.dx, clientY + offset.dy) as HTMLElement | null;
      const connectionEl = candidate?.closest?.('f-connection[data-connection-id]');
      if (connectionEl) {
        const id = connectionEl.getAttribute('data-connection-id');
        if (id) return id;
      }
    }
    return null;
  }

  private buildContextEvent(clientX: number, clientY: number): MouseEvent {
    return new MouseEvent('contextmenu', {
      clientX,
      clientY,
      bubbles: true,
      cancelable: true,
    });
  }

  private updateSelectedNodesFromRect(minX: number, minY: number, maxX: number, maxY: number): void {
    const surface = this.flowSurfaceRef?.nativeElement;
    if (!surface) return;
    const nodes = surface.querySelectorAll<HTMLElement>('.node[data-node-id]');
    const selected = new Set<string>();
    nodes.forEach(node => {
      const id = node.getAttribute('data-node-id');
      if (!id || id === 'start-node' || this.isSyntheticJunctionNodeId(id)) return;
      const rect = node.getBoundingClientRect();
      const intersects =
        rect.left <= maxX &&
        rect.right >= minX &&
        rect.top <= maxY &&
        rect.bottom >= minY;
      if (intersects) {
        selected.add(id);
      }
    });
    this.selectedNodeIds.set(selected);
    this.syncSelectionGroup();
  }

  syncSelectionGroup(): void {
    const selected = Array.from(this.selectedNodeIds()).filter(
      id => id !== 'start-node' && !this.isSyntheticJunctionNodeId(id),
    );
    if (selected.length < 2) {
      this.selectionGroup.set(null);
      return;
    }
    const fallbackSize = { width: 240, height: 80 };
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const nodes = this.nodes();
    selected.forEach(id => {
      const node = nodes.find(n => n.id === id);
      if (!node) return;
      const size = this.getNodeSize(id, fallbackSize);
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + size.width);
      maxY = Math.max(maxY, node.position.y + size.height);
    });
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      this.selectionGroup.set(null);
      return;
    }
    const padding = 12;
    const group: FlowGroup = {
      id: this.selectionGroupId,
      title: 'Selection',
      position: { x: minX - padding, y: minY - padding },
      size: { width: (maxX - minX) + padding * 2, height: (maxY - minY) + padding * 2 },
      collapsed: false,
      nodeIds: selected,
      stepPaths: [],
      expandedSize: null,
    };
    this.selectionGroup.set(group);
  }

  getSelectionParentId(nodeId: string): string | null {
    if (nodeId === 'start-node') {
      return null;
    }
    const group = this.selectionGroup();
    if (!group) {
      return null;
    }
    return this.selectedNodeIds().has(nodeId) ? group.id : null;
  }

  isMultiSensorArgType(type?: string | null): boolean {
    return isMultiSensorType(type);
  }

  isBooleanArgType(type?: string | null): boolean {
    const kind = (type ?? '').trim().toLowerCase();
    return kind === 'bool' || kind === 'boolean';
  }

  isStringArgType(type?: string | null): boolean {
    const kind = (type ?? '').trim().toLowerCase();
    return kind === 'str' || kind === 'string';
  }

  isFloatArgType(type?: string | null): boolean {
    const kind = (type ?? '').trim().toLowerCase();
    return kind === 'float' || kind === 'number';
  }

  isIntegerArgType(type?: string | null): boolean {
    const kind = (type ?? '').trim().toLowerCase();
    return kind === 'int' || kind === 'integer';
  }

  isImplicitIntegerArgType(type: string | null | undefined, name: string, value: unknown, fallback?: unknown): boolean {
    const numeric = this.resolveImplicitNumericValue(type, name, value, fallback);
    return numeric !== null && Number.isInteger(numeric);
  }

  isImplicitFloatArgType(type: string | null | undefined, name: string, value: unknown, fallback?: unknown): boolean {
    const numeric = this.resolveImplicitNumericValue(type, name, value, fallback);
    return numeric !== null && !Number.isInteger(numeric);
  }

  definitionOptionsForArg(type?: string | null, currentValue?: unknown): DefinitionOption[] {
    const baseOptions = this.definitionOptionsForType(type);
    if (!baseOptions.length || resolveDefinitionType(type) !== 'IRSensor') {
      return baseOptions;
    }
    const prefix = this.detectSensorValuePrefix(currentValue);
    if (!prefix) {
      return baseOptions;
    }
    return baseOptions.map(option => ({ label: option.label, value: `${prefix}${option.value}` }));
  }

  definitionOptionsForType(type?: string | null): DefinitionOption[] {
    const key = resolveDefinitionType(type);
    return this.typeDefinitionOptions()[key] ?? [];
  }

  selectedMultiSensors(value: unknown): string[] {
    const key = this.multiSensorSelectionCacheKey(value);
    const cached = this.multiSensorSelectionCache.get(key);
    if (cached) {
      return cached;
    }
    const parsed = parseMultiSensorSelection(value);
    this.multiSensorSelectionCache.set(key, parsed);
    if (this.multiSensorSelectionCache.size > 256) {
      const oldestKey = this.multiSensorSelectionCache.keys().next().value as string | undefined;
      if (oldestKey) {
        this.multiSensorSelectionCache.delete(oldestKey);
      }
    }
    return parsed;
  }

  private multiSensorSelectionCacheKey(value: unknown): string {
    if (Array.isArray(value)) {
      return `arr:${value.map(item => (typeof item === 'string' ? item : String(item))).join('\u001f')}`;
    }
    if (typeof value === 'string') {
      return `str:${value}`;
    }
    if (value == null) {
      return 'null';
    }
    return `other:${String(value)}`;
  }

  private detectSensorValuePrefix(value: unknown): string {
    const selected = parseMultiSensorSelection(value);
    for (const item of selected) {
      const sensor = item.trim();
      if (!sensor) continue;
      const dot = sensor.lastIndexOf('.');
      if (dot <= 0 || dot >= sensor.length - 1) continue;
      return sensor.slice(0, dot + 1);
    }
    return '';
  }

  private resolveImplicitNumericValue(
    type: string | null | undefined,
    name: string,
    value: unknown,
    fallback?: unknown
  ): number | null {
    const kind = (type ?? '').trim().toLowerCase();
    if (kind !== 'any') {
      return null;
    }
    if ((name ?? '').trim().toLowerCase() !== 'speed') {
      return null;
    }
    const candidate = value ?? fallback;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && candidate.trim().length) {
      const parsed = Number(candidate);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private getNodeSize(nodeId: string, fallback: { width: number; height: number }): { width: number; height: number } {
    const els = this.nodeEls?.toArray?.() ?? [];
    for (const ref of els) {
      const el = ref?.nativeElement;
      if (!el) continue;
      if (el.dataset['nodeId'] === nodeId) {
        return { width: el.offsetWidth || fallback.width, height: el.offsetHeight || fallback.height };
      }
    }
    return fallback;
  }

  onSelectionGroupPositionChanged(pos: { x: number; y: number }): void {
    const group = this.selectionGroup();
    if (!group) return;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      return;
    }
    if (Math.abs(pos.x - group.position.x) < 0.5 && Math.abs(pos.y - group.position.y) < 0.5) {
      return;
    }
    this.selectionGroup.set({
      ...group,
      position: { x: pos.x, y: pos.y },
    });
  }

  private stopMultiDrag(): void {
    if (!this.multiDragStartPositions) return;
    this.multiDragStartPositions = null;
    window.removeEventListener('pointerup', this.multiDragPointerUpBound);
  }

  private groupDefinitionsByType(definitions: TypeDefinition[]): DefinitionGroups {
    const grouped: DefinitionGroups = {};
    definitions.forEach(def => {
      const typeName = (def.type ?? '').toString();
      const options = grouped[typeName] ?? (grouped[typeName] = []);
      options.push({ label: def.name, value: def.name });
    });
    Object.values(grouped).forEach(opts => {
      if (!opts) return;
      opts.sort((a, b) => a.label.localeCompare(b.label));
    });
    return grouped;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
