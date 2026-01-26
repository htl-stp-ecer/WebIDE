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
import { FlowHistory } from '../../entities/flow-history';
import { Mission } from '../../entities/Mission';
import { MissionSimulationData, ProjectSimulationData } from '../../entities/Simulation';
import { Connection, FlowComment, FlowGroup, FlowNode, FlowOrientation } from './models';
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
import { DecimalPipe } from '@angular/common';
import { ProgressSpinner } from 'primeng/progressspinner';
import { TableVisualizationPanel } from './table/table-visualization-panel';
import { TimingPanel, type TimingViewMode } from './timing/timing-panel';
import { RobotSettingsModal } from './robot-settings/robot-settings-modal';
import { TableMapService, TableVisualizationService } from './table/services';
import { buildPlannedPathFromProjectSimulation } from './table/simulation-path';
import { PlanningModeService, PlanningOverlayComponent } from './table/planning';

interface DefinitionOption {
  label: string;
  value: string;
}

type DefinitionGroups = Partial<Record<string, DefinitionOption[]>>;
type FloatingPanelKey = 'timing' | 'unity' | 'table';
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

const DEFAULT_VIEW_TOGGLE_STATE: Record<string, boolean> = { timestamps: true, tableVisualization: false };
const DEFAULT_PANEL_OFFSETS: Record<FloatingPanelKey, PanelOffset> = {
  timing: { x: 0, y: 0 },
  unity: { x: 0, y: 0 },
  table: { x: 0, y: 0 },
};

@Component({
  selector: 'app-flowchart',
  imports: [FFlowComponent, FFlowModule, InputNumberModule, CheckboxModule, InputTextModule, ContextMenuModule, Tooltip, SelectButtonModule, FormsModule, TranslateModule, Select, DecimalPipe, ProgressSpinner, TableVisualizationPanel, PlanningOverlayComponent, TimingPanel, RobotSettingsModal],
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
  ];
  readonly panelOffsets = signal<Record<FloatingPanelKey, PanelOffset>>({ ...DEFAULT_PANEL_OFFSETS });
  readonly selectedNodeIds = signal<Set<string>>(new Set());
  readonly selectionRect = signal<{ x: number; y: number; width: number; height: number } | null>(null);
  readonly contextMenuOnPointerUp = true;
  readonly timingViewMode = signal<TimingViewMode>('list');
  readonly simulateRuns = signal<boolean>(true);
  readonly robotSettingsVisible = signal<boolean>(false);
  readonly saveStatus = signal<'idle' | 'saving' | 'saved'>('idle');
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
  private projectSimulationCache: ProjectSimulationData | null = null;
  private robotSettingsWasOpen = false;
  private panelResizeObserver?: ResizeObserver;
  private pendingPanelClamp = false;
  private selectionDrag:
    | { startX: number; startY: number; surfaceRect: DOMRect; moved: boolean }
    | null = null;
  private suppressContextMenuOnce = false;
  private suppressContextMenuTimeout?: ReturnType<typeof setTimeout>;
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
    readonly planningService: PlanningModeService
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
      return next;
    });
  }

  setTimingViewMode(mode: TimingViewMode): void {
    this.timingViewMode.set(mode);
  }

  toggleSimulation(): void {
    this.simulateRuns.update(prev => !prev);
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
    const planned = buildPlannedPathFromProjectSimulation(startPose, data, { lineup: lineupContext });
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

    if (info.rotation_center && isPositiveNumber(width) && isPositiveNumber(length)) {
      const xCm = (width * info.rotation_center.x_pct) / 100;
      const yCm = length * (1 - info.rotation_center.y_pct / 100);
      const forwardCm = yCm - length / 2;
      const strafeCm = (width / 2) - xCm;
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
    orderedSensors.forEach((sensor, index) => {
      if (sensor.x_pct === undefined || sensor.y_pct === undefined) return;
      const xCm = (width * sensor.x_pct) / 100;
      const yCm = length * (1 - sensor.y_pct / 100);
      const forwardCm = yCm - length / 2;
      const strafeCm = (width / 2) - xCm;
      this.tableViz.configureLineSensor(index, forwardCm, strafeCm);
    });
  }

  openRobotSettings(): void {
    this.robotSettingsVisible.set(true);
  }

  isNodeSelected(nodeId: string): boolean {
    return this.selectedNodeIds().has(nodeId);
  }

  clearNodeSelection(): void {
    if (this.selectedNodeIds().size) {
      this.selectedNodeIds.set(new Set());
    }
  }

  onNodePointerDown(event: PointerEvent, nodeId: string): void {
    if (!event.isPrimary || event.button !== 0) return;
    const current = this.selectedNodeIds();
    if (!current.has(nodeId)) {
      this.selectedNodeIds.set(new Set([nodeId]));
      this.stopMultiDrag();
      return;
    }
    if (current.size > 1) {
      this.startMultiDrag();
    }
  }

  onSurfacePointerDown(event: PointerEvent): void {
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
    if (nodeId && nodeId !== 'start-node') {
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
      if (!id || id === 'start-node') return;
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
  }

  private startMultiDrag(): void {
    const selected = this.selectedNodeIds();
    if (selected.size < 2) return;
    const positions = new Map<string, { x: number; y: number }>();
    this.nodes().forEach(node => {
      if (selected.has(node.id)) {
        positions.set(node.id, { x: node.position.x, y: node.position.y });
      }
    });
    this.multiDragStartPositions = positions;
    window.addEventListener('pointerup', this.multiDragPointerUpBound);
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
