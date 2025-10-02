import {
  AfterViewChecked,
  Component,
  OnDestroy,
  Signal,
  effect,
  QueryList,
  signal,
  viewChild,
  ViewChildren,
  ElementRef,
  ViewChild,
} from '@angular/core';
import {
  EFMarkerType,
  FCanvasComponent,
  FCreateConnectionEvent,
  FCreateNodeEvent,
  FFlowComponent,
  FFlowModule,
  FNodeIntersectedWithConnections
} from '@foblex/flow';
import {IPoint} from '@foblex/2d';
import {generateGuid} from '@foblex/utils';
import {InputNumberModule} from 'primeng/inputnumber';
import {CheckboxModule} from 'primeng/checkbox';
import {InputTextModule} from 'primeng/inputtext';
import {MissionStateService} from '../../services/mission-sate-service';
import {Mission} from '../../entities/Mission';
import {MissionStep} from '../../entities/MissionStep';
import {StepsStateService} from '../../services/steps-state-service';
import {ContextMenuModule, ContextMenu} from 'primeng/contextmenu';
import {MenuItem} from 'primeng/api';
import {Tooltip} from 'primeng/tooltip';
import {FormsModule} from '@angular/forms';
import { Subscription } from 'rxjs';

// Shared models and helpers
import { Connection, FlowNode, Step, baseId, toVal } from './models';
import {
  attachToStartWithParallel,
  detachEverywhere,
  normalize,
  attachChildWithParallel,
  attachChildSequentially,
  shouldAppendSequentially,
} from './mission-utils';
import { computeAutoLayout } from './layout-utils';
import { rebuildMissionView } from './mission-builder';
import { insertBetween } from './mission-utils';
import { asStepFromPool, initialArgsFromPool, missionStepFromAdHoc } from './step-utils';
import {HttpService} from '../../services/http-service';
import { FlowHistory, FlowSnapshot } from './flow-history';
import {ActivatedRoute} from '@angular/router';

@Component({
  selector: 'app-flowchart',
  imports: [FFlowComponent, FFlowModule, InputNumberModule, CheckboxModule, InputTextModule, ContextMenuModule, Tooltip, FormsModule],
  templateUrl: './flowchart.html',
  styleUrl: './flowchart.scss',
  providers: [FlowHistory],
  standalone: true
})
export class Flowchart implements AfterViewChecked, OnDestroy {
  // Reflect app theme (class-based, e.g., Tailwind/PrimeNG) instead of OS preference
  readonly isDarkMode = signal<boolean>(this.readDarkMode());
  protected readonly eMarkerType = EFMarkerType;

  // Rendered state for <f-flow>
  readonly nodes = signal<FlowNode[]>([]);
  readonly connections = signal<Connection[]>([]);
  readonly isRunActive = signal(false);

  // Mission vs ad-hoc layers
  private readonly missionNodes = signal<FlowNode[]>([]);
  private readonly missionConnections = signal<Connection[]>([]);
  private readonly adHocNodes = signal<FlowNode[]>([]);
  private readonly adHocConnections = signal<Connection[]>([]);

  // Per-mission ad-hoc memory
  private readonly adHocPerMission = new Map<string, { nodes: FlowNode[]; connections: Connection[] }>();
  private currentMissionKey: string | null = null;
  private runSubscription: Subscription | null = null;

  fCanvas = viewChild(FCanvasComponent);
  @ViewChildren('nodeElement') nodeEls!: QueryList<ElementRef<HTMLDivElement>>;
  @ViewChild('cm') cm!: ContextMenu;

  private readonly START_NODE = 'start-node' as const;
  private readonly START_OUT = 'start-node-output' as const;

  private stepToNodeId = new Map<MissionStep, string>();
  private nodeIdToStep = new Map<string, MissionStep>();
  private pathToNodeId = new Map<string, string>();
  private pathToConnectionIds = new Map<string, string[]>();
  private stepPaths = new Map<MissionStep, number[]>();
  private plannedStepsByIndex = new Map<number, string>();
  private plannedStepsByOrder = new Map<number, string>();
  private needsAdjust = false;
  private selectedNodeId = '';
  private pendingViewportReset = false;
  private projectUUID: string | null = '';

  private readonly completedNodeIds = signal<Set<string>>(new Set());
  private readonly completedConnectionIds = signal<Set<string>>(new Set());

  readonly items: MenuItem[] = [{label: 'Delete', icon: 'pi pi-trash', command: () => this.deleteNode()}];

  private historyInitialized = false;
  private isRestoringHistory = false;
  private ignoreMissionEffect = false;
  private isHistoryTraversal = false;

  protected canUndoSignal!: Signal<boolean>;
  protected canRedoSignal!: Signal<boolean>;

  constructor(private missionState: MissionStateService, private stepsState: StepsStateService, private http: HttpService, private route: ActivatedRoute, private readonly history: FlowHistory) {
    // Observe theme class changes on <html> and <body>

    this.projectUUID = route.snapshot.paramMap.get('uuid');
    this.history.initialize(this.buildSnapshot());
    this.historyInitialized = true;
    this.canUndoSignal = this.history.canUndo;
    this.canRedoSignal = this.history.canRedo;
    const onThemeChange = () => this.isDarkMode.set(this.readDarkMode());
    const mo = new MutationObserver(onThemeChange);
    try {
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    } catch {}
    effect(() => {
      const mission = this.missionState.currentMission();
      if (this.isRestoringHistory) {
        return;
      }
      if (this.ignoreMissionEffect) {
        this.ignoreMissionEffect = false;
        return;
      }
      const newKey = mission ? ((mission as any).uuid ?? mission.name) : null;
      const missionChanged = newKey !== this.currentMissionKey;

      if (missionChanged) {
        if (this.currentMissionKey) {
          this.adHocPerMission.set(this.currentMissionKey, {
            nodes: this.cloneNodes(this.adHocNodes()),
            connections: this.cloneConnections(this.adHocConnections())
          });
        }
        const saved = newKey ? this.adHocPerMission.get(newKey) : null;
        this.missionNodes.set([]);
        this.missionConnections.set([]);
        this.nodes.set([]);
        this.connections.set([]);
        this.adHocNodes.set(this.cloneNodes(saved?.nodes ?? []));
        this.adHocConnections.set(this.cloneConnections(saved?.connections ?? []));
        this.pendingViewportReset = true;
        this.currentMissionKey = newKey;
        this.historyInitialized = false;
      }

      if (mission) {
        this.rebuildFromMission(mission);
        this.needsAdjust = true;
      } else {
        this.missionNodes.set([]);
        this.missionConnections.set([]);
        this.nodes.set([]);
        this.connections.set([]);
      }

      if (missionChanged) {
        this.resetHistoryWithCurrentState();
      }
    });

    effect(() => {
      this.history.changes();
      if (!this.isHistoryTraversal) {
        return;
      }
      const snapshot = this.history.getSnapshot();
      this.applyHistorySnapshot(snapshot);
      this.isHistoryTraversal = false;
    });
  }

  protected undo(): void {
    if (!this.canUndoSignal()) {
      return;
    }
    this.isHistoryTraversal = true;
    this.history.undo();
  }

  protected redo(): void {
    if (!this.canRedoSignal()) {
      return;
    }
    this.isHistoryTraversal = true;
    this.history.redo();
  }

  private recordHistory(notifier: string): void {
    if (this.isRestoringHistory) {
      return;
    }
    const snapshot = this.buildSnapshot();
    if (!this.historyInitialized) {
      this.history.initialize(snapshot);
      this.historyInitialized = true;
      return;
    }
    this.history.update(snapshot, notifier);
  }

  private resetHistoryWithCurrentState(): void {
    const snapshot = this.buildSnapshot();
    this.history.initialize(snapshot);
    this.historyInitialized = true;
  }

  private applyHistorySnapshot(snapshot: FlowSnapshot): void {
    this.isRestoringHistory = true;
    try {
      const missionClone = this.cloneMission(snapshot.mission);
      this.ignoreMissionEffect = true;
      this.missionState.currentMission.set(missionClone);
      this.ignoreMissionEffect = false;
      const missionNodes = this.cloneNodes(snapshot.missionNodes);
      const missionConnections = this.cloneConnections(snapshot.missionConnections);
      const adHocNodes = this.cloneNodes(snapshot.adHocNodes);
      const adHocConnections = this.cloneConnections(snapshot.adHocConnections);
      this.missionNodes.set(missionNodes);
      this.missionConnections.set(missionConnections);
      this.adHocNodes.set(adHocNodes);
      this.adHocConnections.set(adHocConnections);
      if (this.currentMissionKey) {
        this.adHocPerMission.set(this.currentMissionKey, {
          nodes: this.cloneNodes(adHocNodes),
          connections: this.cloneConnections(adHocConnections)
        });
      }
      this.recomputeMergedView();
      this.needsAdjust = true;
      this.historyInitialized = true;
    } finally {
      this.isRestoringHistory = false;
    }
  }

  private buildSnapshot(): FlowSnapshot {
    return {
      mission: this.cloneMission(this.missionState.currentMission()),
      missionNodes: this.cloneNodes(this.missionNodes()),
      missionConnections: this.cloneConnections(this.missionConnections()),
      adHocNodes: this.cloneNodes(this.adHocNodes()),
      adHocConnections: this.cloneConnections(this.adHocConnections()),
    };
  }

  private cloneNodes(nodes: FlowNode[] | undefined): FlowNode[] {
    return this.clonePlain(nodes ?? []);
  }

  private cloneConnections(connections: Connection[] | undefined): Connection[] {
    return this.clonePlain(connections ?? []);
  }

  private cloneMission(mission: Mission | null): Mission | null {
    return mission ? this.clonePlain(mission) : null;
  }

  private clonePlain<T>(value: T): T {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private readDarkMode(): boolean {
    try {
      const de = document.documentElement, b = document.body;
      return !!(de?.classList?.contains('dark') || b?.classList?.contains('dark') ||
        de?.classList?.contains('p-dark') || b?.classList?.contains('p-dark'));
    } catch {
      return false;
    }
  }

  // ----- lifecycle -----
  ngAfterViewChecked(): void {
    if (this.needsAdjust) {
      this.needsAdjust = false;
      this.autoLayout();
    }
    if (this.pendingViewportReset) {
      this.pendingViewportReset = false;
      this.fCanvas()?.resetScaleAndCenter(false);
    }
  }

  onLoaded() {
    this.fCanvas()?.resetScaleAndCenter(false);
  }

  // ----- dom helpers -----
  private heights(): Map<string, number> {
    const m = new Map<string, number>();
    this.nodeEls.forEach(el => {
      const id = el.nativeElement.dataset['nodeId'];
      if (id) m.set(id, el.nativeElement.offsetHeight || 80);
    });
    return m;
  }

  private cleanupAdHocNode(id: string): void {
    const inputId = `${id}-input`, outputId = `${id}-output`;
    this.adHocNodes.set(this.adHocNodes().filter(n => n.id !== id));
    this.adHocConnections.set(this.adHocConnections().filter(c => c.inputId !== inputId && c.outputId !== outputId));
  }

  private recomputeMergedView(): void {
    const allNodes = [...this.missionNodes(), ...this.adHocNodes()];
    const ids = new Set(allNodes.map(n => n.id));
    const valid = (x: string, kind: 'in' | 'out') => kind === 'in' ? ids.has(x.replace(/-input$/, '')) : x === this.START_OUT || ids.has(x.replace(/-output$/, ''));
    const adhocConns = this.adHocConnections().filter(c => valid(c.outputId, 'out') && valid(c.inputId, 'in'));
    this.nodes.set(allNodes);
    this.connections.set([...this.missionConnections(), ...adhocConns]);
  }

  // ----- movement -----
  onNodeMoved(nodeId: string, pos: IPoint) {
    const upd = (sig: typeof this.adHocNodes | typeof this.missionNodes) => {
      const arr = sig();
      const i = arr.findIndex(n => n.id === nodeId);
      if (i < 0) return false;
      const next = arr.slice();
      next[i] = {...next[i], position: {x: pos.x, y: pos.y}};
      sig.set(next);
      return true;
    };
    let changed = upd(this.adHocNodes);
    if (!changed) {
      changed = upd(this.missionNodes);
    }
    if (!changed) {
      return;
    }
    this.recomputeMergedView();
    this.recordHistory('move-node');
  }

  // ----- layout (transparent wrappers skipped) -----
  private autoLayout(): void {
    const mission = this.missionState.currentMission();
    const h = this.heights();
    const laidOut = computeAutoLayout(mission, this.nodes(), this.stepToNodeId, h, this.START_NODE);
    this.nodes.set(laidOut);
  }

  private rebuildFromMission(mission: Mission): void {
    this.computeStepPaths(mission);
    const old = new Map(this.stepToNodeId);
    const res = rebuildMissionView(
      mission,
      old,
      (ms) => asStepFromPool(ms, this.stepsState.currentSteps() ?? []),
      (ms) => initialArgsFromPool(ms, this.stepsState.currentSteps() ?? []),
      this.START_OUT,
      (ms) => this.stepPaths.get(ms),
    );
    this.stepToNodeId = res.stepToNodeId;
    this.nodeIdToStep = res.nodeIdToStep;
    this.pathToNodeId = res.pathToNodeId;
    this.pathToConnectionIds = res.pathToConnectionIds;
    this.missionNodes.set(res.nodes);
    this.missionConnections.set(res.connections);
    this.recomputeMergedView();
    this.clearRunVisuals();
  }

  private computeStepPaths(mission: Mission | null): void {
    this.stepPaths = new Map();
    if (!mission) {
      return;
    }

    const visit = (steps: MissionStep[] | undefined, prefix: number[]): void => {
      (steps ?? []).forEach((step, idx) => {
        const path = [...prefix, idx + 1];
        this.stepPaths.set(step, path);
        if (step.children?.length) {
          visit(step.children, path);
        }
      });
    };

    visit(mission.steps, []);
  }

  private clearRunVisuals(): void {
    this.completedNodeIds.set(new Set<string>());
    this.completedConnectionIds.set(new Set<string>());
    this.plannedStepsByIndex.clear();
    this.plannedStepsByOrder.clear();
  }

  isNodeCompleted(nodeId: string): boolean {
    return this.completedNodeIds().has(nodeId);
  }

  isConnectionCompleted(connectionId: string): boolean {
    return this.completedConnectionIds().has(connectionId);
  }

  private cachePlannedSteps(payload: unknown): void {
    this.plannedStepsByIndex.clear();
    this.plannedStepsByOrder.clear();

    const steps = (payload as any)?.steps;
    if (!Array.isArray(steps)) {
      return;
    }

    steps.forEach((step: any, idx: number) => {
      const pathKey = this.normalizePathKey(step?.path);
      if (!pathKey) {
        return;
      }

      const timelineIdx = Number(step?.index);
      if (Number.isInteger(timelineIdx)) {
        this.plannedStepsByIndex.set(timelineIdx, pathKey);
      }

      const sequentialIdx = idx + 1;
      this.plannedStepsByOrder.set(sequentialIdx, pathKey);
    });
  }

  private normalizePathKey(raw: unknown): string | undefined {
    if (!Array.isArray(raw)) {
      return undefined;
    }

    const parts: number[] = [];
    for (const part of raw) {
      const num = Number(part);
      if (!Number.isInteger(num) || num <= 0) {
        return undefined;
      }
      parts.push(num);
    }

    return parts.length ? parts.join('.') : undefined;
  }

  private recordCompletedPathKey(pathKey?: string | null): void {
    if (!pathKey) {
      return;
    }

    const nodeId = this.pathToNodeId.get(pathKey);
    if (!nodeId) {
      return;
    }

    this.completedNodeIds.update((prev) => {
      if (prev.has(nodeId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });

    const connIds = this.pathToConnectionIds.get(pathKey) ?? [];
    if (connIds.length) {
      this.completedConnectionIds.update((prev) => {
        let needsCopy = false;
        for (const id of connIds) {
          if (!prev.has(id)) {
            needsCopy = true;
            break;
          }
        }
        if (!needsCopy) {
          return prev;
        }
        const next = new Set(prev);
        connIds.forEach(id => next.add(id));
        return next;
      });
    }
  }

  private resolvePathKeyFromEvent(event: any): string | undefined {
    const direct = this.normalizePathKey(event?.path);
    if (direct) {
      return direct;
    }

    const timelineIdx = Number(event?.timeline_index);
    if (Number.isInteger(timelineIdx)) {
      const viaTimeline = this.plannedStepsByIndex.get(timelineIdx);
      if (viaTimeline) {
        return viaTimeline;
      }
    }

    const seqIdx = Number(event?.index);
    if (Number.isInteger(seqIdx)) {
      return this.plannedStepsByIndex.get(seqIdx) ?? this.plannedStepsByOrder.get(seqIdx);
    }

    return undefined;
  }

  private handleStepEvent(event: any): void {
    const pathKey = this.resolvePathKeyFromEvent(event);
    this.recordCompletedPathKey(pathKey);
  }

  private handleRunEvent(event: any): void {
    if (!event || typeof event !== 'object') {
      return;
    }

    switch ((event as any).type) {
      case 'open':
        this.isRunActive.set(true);
        break;
      case 'planned_steps':
        this.cachePlannedSteps(event);
        break;
      case 'step':
        this.handleStepEvent(event);
        break;
      case 'exit':
      case 'error':
        this.isRunActive.set(false);
        break;
      default:
        break;
    }
  }

  onCreateNode(e: FCreateNodeEvent) {
    const step = e.data as Step;
    const args: Record<string, boolean | string | number | null> = {};
    step?.arguments?.forEach(a => args[a.name] = toVal(a.type, String((a.default ?? '') !== '' ? a.default : '')));
    this.adHocNodes.set([...this.adHocNodes(), {
      id: generateGuid(),
      text: step?.name ?? 'New Node',
      position: e.rect,
      step,
      args
    }]);
    this.recomputeMergedView();
    this.needsAdjust = true;
    this.recordHistory('create-node');
  }

  addConnection(e: FCreateConnectionEvent): void {
    if (!e.fInputId) return;
    const mission = this.missionState.currentMission();
    if (!mission) return;

    const srcId = baseId(e.fOutputId, 'output');
    const dstId = baseId(e.fInputId, 'input');

    // Prevent self-connections (node output -> same node input)
    if (srcId === dstId) {
      return;
    }
    const srcStep = this.nodeIdToStep.get(srcId);
    const dstStep = this.nodeIdToStep.get(dstId);

    // CHANGED: when promoting an ad-hoc node under a generated parent, attach via PARALLEL
    const promote = (adhocId: string, parent?: MissionStep) => {
      const n = this.adHocNodes().find(x => x.id === adhocId);
      if (!n) return false;
      const mStep = missionStepFromAdHoc(n);
      this.stepToNodeId.set(mStep, n.id); // keep visual continuity

      if (parent) {
        let attached = false;
        if (shouldAppendSequentially(mission, parent)) {
          attached = attachChildSequentially(mission, parent, mStep);
        }
        if (!attached) {
          attachChildWithParallel(mission, parent, mStep);
        }
      } else {
        (mission.steps ??= []).push(mStep);
      }

      this.cleanupAdHocNode(n.id);
      this.rebuildFromMission(mission);
      this.needsAdjust = true;
      this.recordHistory('promote-node');
      return true;
    };

    // (optional) keep your "start → parallel bucket" behavior
    if (srcId === this.START_NODE) {
      // If you want top-level connections from Start to also fan-out in parallel, keep this block.
      if (
        (dstStep && attachToStartWithParallel(mission, dstStep)) ||
        (!dstStep && (() => {
          const n = this.adHocNodes().find(x => x.id === dstId);
          if (!n) return false;
          const m = missionStepFromAdHoc(n);
          this.stepToNodeId.set(m, n.id);
          this.cleanupAdHocNode(n.id);
          return attachToStartWithParallel(mission, m);
        })())
      ) {
        this.rebuildFromMission(mission);
        this.needsAdjust = true;
        this.recordHistory('attach-to-start');
        return;
      }
    }

    // CHANGED: generated → ad-hoc attaches in PARALLEL after the source step
    if (srcStep && !dstStep && promote(dstId, srcStep)) return;

    // CHANGED: generated → generated attaches in PARALLEL
    if (srcStep && dstStep && attachChildWithParallel(mission, srcStep, dstStep)) {
      this.rebuildFromMission(mission);
      this.needsAdjust = true;
      this.recordHistory('connect-existing-steps');
      return;
    }

    // fallback: just draw an ad-hoc wire
    this.adHocConnections.set([
      ...this.adHocConnections(),
      {id: generateGuid(), outputId: e.fOutputId, inputId: e.fInputId}
    ]);
    this.recomputeMergedView();
    this.recordHistory('create-adhoc-connection');
  }


  // ----- context menu -----
  onRightClick(ev: MouseEvent, nodeId: string) {
    ev.preventDefault();
    this.selectedNodeId = nodeId;
    this.cm.show(ev);
  }

  deleteNode(): void {
    const id = this.selectedNodeId;
    if (!id) return;
    const step = this.nodeIdToStep.get(id), mission = this.missionState.currentMission();

    let changed = false;

    if (step && mission) {
      let removed = false;
      const remove = (arr?: MissionStep[]) => {
        if (!arr) return;
        for (let i = 0; i < arr.length;) {
          const s = arr[i];
          if (s === step) {
            arr.splice(i, 1);
            removed = true;
            continue;
          }
          remove(s.children);
          i++;
        }
      };
      remove(mission.steps);
      if (removed) {
        normalize(mission, 'parallel');
        normalize(mission, 'seq');
        this.rebuildFromMission(mission);
        changed = true;
      }
    } else {
      const before = this.adHocNodes().length;
      this.cleanupAdHocNode(id);
      if (this.adHocNodes().length !== before) {
        this.recomputeMergedView();
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    this.needsAdjust = true;
    this.recordHistory('delete-node');
  }

  // extracted helpers from mission-utils.ts used below

  // ----- drop-in split insert -----
  onNodeIntersectedWithConnection(event: FNodeIntersectedWithConnections): void {
    const nodeId = event.fNodeId, hitId = event.fConnectionIds?.[0];
    if (!hitId || nodeId === this.START_NODE) return;
    const adhoc = this.adHocConnections();
    const ai = adhoc.findIndex(c => c.id === hitId);
    if (ai !== -1) {
      const hit = adhoc[ai], prevIn = hit.inputId, updated = adhoc.slice();
      updated[ai] = {...hit, inputId: `${nodeId}-input`};
      updated.push({id: generateGuid(), outputId: `${nodeId}-output`, inputId: prevIn});
      this.adHocConnections.set(updated);
      this.recomputeMergedView();
      this.recordHistory('split-adhoc-connection');
      return;
    }

    const mission = this.missionState.currentMission();
    if (!mission) return;
    const hit = this.connections().find(c => c.id === hitId);
    if (!hit) return;

    const srcBase = baseId(hit.outputId, 'output'), dstBase = baseId(hit.inputId, 'input');
    const parentStep = srcBase === this.START_NODE ? null : this.nodeIdToStep.get(srcBase) ?? null;
    const childStep = this.nodeIdToStep.get(dstBase);
    if (!childStep) return;

    let midStep: MissionStep | null = this.nodeIdToStep.get(nodeId) ?? null;
    if (!midStep) {
      const n = this.adHocNodes().find(x => x.id === nodeId);
      if (!n) return;
      midStep = missionStepFromAdHoc(n);
      this.stepToNodeId.set(midStep, n.id);
      this.cleanupAdHocNode(n.id);
    }
    if (midStep === parentStep || midStep === childStep) return;
    detachEverywhere(mission, midStep);

    if (insertBetween(mission, parentStep, childStep, midStep)) {
      this.rebuildFromMission(mission);
      this.needsAdjust = true;
      this.recordHistory('split-mission-connection');
    }
  }

  ngOnDestroy(): void {
    this.stopRun();
  }

  stopRun(): void {
    const hadSubscription = !!this.runSubscription;
    const wasActive = this.isRunActive();

    if (!hadSubscription && !wasActive) {
      return;
    }

    this.runSubscription?.unsubscribe();
    this.runSubscription = null;
    this.isRunActive.set(false);

    if (this.projectUUID) {
      this.http.stopMission(this.projectUUID).subscribe({
        error: err => console.error('Failed to stop mission', err),
      });
    }
  }

  onRun(mode: 'normal' | 'debug'): void {
    if (mode === 'normal') {
      if (!this.projectUUID || !this.currentMissionKey) {
        console.warn('Run aborted: missing project or mission identifier.');
        return;
      }

      if (this.runSubscription) {
        this.runSubscription.unsubscribe();
        this.runSubscription = null;
      }

      this.clearRunVisuals();

      const projectId = this.projectUUID;
      const missionName = this.currentMissionKey;

      this.isRunActive.set(true);
      this.runSubscription = this.http.runMission(projectId, missionName).subscribe({
        next: event => this.handleRunEvent(event),
        error: err => {
          console.error('Mission run failed', err);
          this.isRunActive.set(false);
          this.runSubscription = null;
        },
        complete: () => {
          this.isRunActive.set(false);
          this.runSubscription = null;
        },
      });
    } else {
      console.log('Debug!');
    }
  }
}
