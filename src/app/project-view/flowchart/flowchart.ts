import { AfterViewChecked, Component, ElementRef, OnDestroy, OnInit, QueryList, Signal, ViewChild, ViewChildren, signal, viewChild } from '@angular/core';
import { EFMarkerType, FCanvasComponent, FFlowComponent, FFlowModule } from '@foblex/flow';
import { ContextMenu, ContextMenuModule } from 'primeng/contextmenu';
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
import {Select} from 'primeng/select';
import {DecimalPipe} from '@angular/common';
import { UnityCanvasPanel } from './unity/unity-canvas-panel';
import { TableEditorPanel } from './unity/table-editor-panel';
import { TimingPanel, type TimingViewMode } from './timing/timing-panel';

interface DefinitionOption {
  label: string;
  value: string;
}

type DefinitionGroups = Partial<Record<string, DefinitionOption[]>>;
type FloatingPanelKey = 'timing' | 'unity' | 'table';

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

const DEFAULT_VIEW_TOGGLE_STATE: Record<string, boolean> = { timestamps: true, unityCanvas: false, tableEditor: false };
const DEFAULT_PANEL_OFFSETS: Record<FloatingPanelKey, PanelOffset> = {
  timing: { x: 0, y: 0 },
  unity: { x: 0, y: 0 },
  table: { x: 0, y: 0 },
};

@Component({
  selector: 'app-flowchart',
  imports: [FFlowComponent, FFlowModule, InputNumberModule, CheckboxModule, InputTextModule, ContextMenuModule, Tooltip, SelectButtonModule, FormsModule, TranslateModule, Select, DecimalPipe, UnityCanvasPanel, TableEditorPanel, TimingPanel],
  templateUrl: './flowchart.html',
  styleUrl: './flowchart.scss',
  providers: [FlowHistory],
  standalone: true,
})
export class Flowchart implements AfterViewChecked, OnDestroy, OnInit {
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
  readonly viewToggleState = signal<Record<string, boolean>>(readStoredViewToggleState(DEFAULT_VIEW_TOGGLE_STATE));
  readonly viewToggleOptions = [
    { key: 'timestamps', labelKey: 'FLOWCHART.VIEW_TOGGLE_TIMESTAMPS', icon: 'pi pi-clock' },
    { key: 'unityCanvas', labelKey: 'FLOWCHART.VIEW_TOGGLE_SIMULATION', icon: 'pi pi-desktop' },
    { key: 'tableEditor', labelKey: 'FLOWCHART.VIEW_TOGGLE_TABLE_EDITOR', icon: 'pi pi-table' },
  ];
  readonly panelOffsets = signal<Record<FloatingPanelKey, PanelOffset>>({ ...DEFAULT_PANEL_OFFSETS });
  unityBaseUrl = `${globalThis.location?.protocol ?? 'http:'}//${globalThis.location?.hostname ?? 'localhost'}:8000`;
  readonly timingViewMode = signal<TimingViewMode>('list');
  readonly simulateRuns = signal<boolean>(true);
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
  unityBaseUrlSub?: Subscription;
  langChangeSub?: Subscription;
  themeObserver?: MutationObserver;
  typeDefinitionsSub?: Subscription;
  private _useAutoLayout = readStoredAutoLayout();
  private activePanelDrag: PanelDragState | null = null;

  constructor(
    readonly missionState: MissionStateService,
    readonly stepsState: StepsStateService,
    readonly http: HttpService,
    readonly route: ActivatedRoute,
    readonly history: FlowHistory,
    readonly translate: TranslateService
  ) {
    this.historyManager = createHistoryManager(this);
    this.runManager = createRunManager(this);
    this.actions = createFlowchartActions(this);
    initializeFlowchart(this);
  }

  ngOnInit(): void {
    this.loadTypeDefinitions();
    this.unityBaseUrlSub = this.http.ip$.subscribe(ip => {
      if (ip) this.unityBaseUrl = ip;
    });
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

  ngOnDestroy(): void {
    this.actions.stopRun();
    this.stopPanelDrag();
    this.unityBaseUrlSub?.unsubscribe();
    this.langChangeSub?.unsubscribe();
    this.themeObserver?.disconnect();
    this.typeDefinitionsSub?.unsubscribe();
  }

  private loadTypeDefinitions(): void {
    this.typeDefinitionsSub?.unsubscribe();
    const projectUUID = this.projectUUID;
    if (!projectUUID) {
      this.typeDefinitionOptions.set({});
      return;
    }
    this.typeDefinitionsSub = this.http.getTypeDefinitions(projectUUID).subscribe({
      next: defs => this.typeDefinitionOptions.set(this.groupDefinitionsByType(defs)),
      error: () => this.typeDefinitionOptions.set({}),
    });
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
