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
import { Connection, FlowComment, FlowNode, FlowOrientation } from './models';
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
import { ChartModule } from 'primeng/chart';
import type { ChartData, ChartOptions } from 'chart.js';
import {DecimalPipe} from '@angular/common';
import { UnityCanvasPanel } from './unity/unity-canvas-panel';
import { TableEditorPanel } from './unity/table-editor-panel';

interface DefinitionOption {
  label: string;
  value: string;
}

type DefinitionGroups = Partial<Record<string, DefinitionOption[]>>;
type TimingViewMode = 'list' | 'chart';

const DEFAULT_VIEW_TOGGLE_STATE: Record<string, boolean> = { timestamps: true, unityCanvas: false, tableEditor: false };

@Component({
  selector: 'app-flowchart',
  imports: [FFlowComponent, FFlowModule, InputNumberModule, CheckboxModule, InputTextModule, ContextMenuModule, Tooltip, SelectButtonModule, FormsModule, TranslateModule, Select, DecimalPipe, ChartModule, UnityCanvasPanel, TableEditorPanel],
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
    { key: 'timestamps', label: 'Show timestamps', icon: 'pi pi-clock' },
    { key: 'unityCanvas', label: 'Simulation', icon: 'pi pi-desktop' },
    { key: 'tableEditor', label: 'Table editor', icon: 'pi pi-table' },
  ];
  unityBaseUrl = `${globalThis.location?.protocol ?? 'http:'}//${globalThis.location?.hostname ?? 'localhost'}:8000`;
  readonly timingViewMode = signal<TimingViewMode>('list');
  readonly simulateRuns = signal<boolean>(true);
  actions!: FlowchartActions;
  readonly eMarkerType = EFMarkerType;
  orientationOptions: { label: string; value: FlowOrientation }[] = [];
  fCanvas = viewChild(FCanvasComponent);
  @ViewChildren('nodeElement') nodeEls!: QueryList<ElementRef<HTMLDivElement>>;
  @ViewChildren('commentTextarea') commentTextareas!: QueryList<ElementRef<HTMLTextAreaElement>>;
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
    this.unityBaseUrlSub?.unsubscribe();
    this.langChangeSub?.unsubscribe();
    this.themeObserver?.disconnect();
    this.typeDefinitionsSub?.unsubscribe();
  }

  private loadTypeDefinitions(): void {
    this.typeDefinitionsSub?.unsubscribe();
    this.typeDefinitionsSub = this.http.getTypeDefinitions().subscribe({
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

  get timingChartData(): ChartData<'line'> {
    const timings = this.runManager.stepTimings();
    const labels = timings.map(t => t.label || t.path || `Step ${t.index}`);
    const data = timings.map(t => +(t.durationMs / 1000).toFixed(3));

    return {
      labels,
      datasets: [
        {
          label: 'Duration (s)',
          data,
          borderColor: '#22c55e',
          backgroundColor: '#22c55e',
          pointBackgroundColor: '#22c55e',
          pointBorderColor: '#22c55e',
          pointRadius: 5,
          pointHoverRadius: 7,
          tension: 0.3,
          fill: false,
        },
      ],
    };
  }

  get timingChartOptions(): ChartOptions<'line'> {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => (items[0]?.label ? [items[0].label] : []),
            label: ctx => `Duration: ${ctx.formattedValue}s`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Step' },
          ticks: { autoSkip: false, maxRotation: 35, minRotation: 0 },
        },
        y: {
          title: { display: true, text: 'Duration (s)' },
          beginAtZero: true,
        },
      },
    };
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
