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
  FCanvasChangeEvent,
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
import {SelectButtonModule} from 'primeng/selectbutton';
import {FormsModule} from '@angular/forms';
import { FlowchartHistoryManager } from './flowchart-history-manager';
import { FlowchartRunManager } from './flowchart-run-manager';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

// Shared models and helpers
import { Connection, FlowComment, FlowNode, FlowOrientation, Step, baseId, toVal } from './models';
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
import {ActivatedRoute} from '@angular/router';
import {FlowHistory} from '../../entities/flow-history';
import {NotificationService} from '../../services/NotificationService';

@Component({
  selector: 'app-flowchart',
  imports: [FFlowComponent, FFlowModule, InputNumberModule, CheckboxModule, InputTextModule, ContextMenuModule, Tooltip, SelectButtonModule, FormsModule, TranslateModule],
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
  readonly comments = signal<FlowComment[]>([]);
  readonly isRunActive = signal(false);
  protected readonly orientation = signal<FlowOrientation>('vertical');
  protected orientationOptions: { label: string; value: FlowOrientation }[] = [];
  private readonly layoutSpacing = {
    vertical: { laneWidth: 275, gap: 75 },
    horizontal: { laneWidth: 275, gap: 350 },
  } as const;

  // Mission vs ad-hoc layers
  private readonly missionNodes = signal<FlowNode[]>([]);
  private readonly missionConnections = signal<Connection[]>([]);
  private readonly adHocNodes = signal<FlowNode[]>([]);
  private readonly adHocConnections = signal<Connection[]>([]);

  // Per-mission ad-hoc memory
  private readonly historyManager: FlowchartHistoryManager;
  private readonly runManager: FlowchartRunManager;

  fCanvas = viewChild(FCanvasComponent);
  @ViewChildren('nodeElement') nodeEls!: QueryList<ElementRef<HTMLDivElement>>;
  @ViewChildren('commentTextarea') commentTextareas!: QueryList<ElementRef<HTMLTextAreaElement>>;
  @ViewChild('cm') cm!: ContextMenu;

  private readonly START_NODE = 'start-node' as const;
  private readonly START_OUT = 'start-node-output' as const;

  private stepToNodeId = new Map<MissionStep, string>();
  private nodeIdToStep = new Map<string, MissionStep>();
  private pathToNodeId = new Map<string, string>();
  private pathToConnectionIds = new Map<string, string[]>();
  private stepPaths = new Map<MissionStep, number[]>();
  private needsAdjust = false;
  private selectedNodeId = '';
  private selectedCommentId = '';
  private pendingViewportReset = false;
  private projectUUID: string | null = '';
  private lastNodeHeights = new Map<string, number>();

  items: MenuItem[] = [];
  private nodeContextMenuItems: MenuItem[] = [];
  private commentContextMenuItems: MenuItem[] = [];
  private canvasContextMenuItems: MenuItem[] = [];
  private contextMenuEventPosition: { clientX: number; clientY: number } | null = null;
  private commentDraftTexts = new Map<string, string>();
  private readonly canvasTransform = signal<{ position: IPoint; scale: number }>({ position: { x: 0, y: 0 }, scale: 1 });
  private langChangeSub?: Subscription;

  protected canUndoSignal!: Signal<boolean>;
  protected canRedoSignal!: Signal<boolean>;

  private _useAutoLayout = this.readStoredAutoLayout();
  protected commentHeaderLabel = 'Comment';
  protected commentPlaceholder = 'Write a comment...';

  protected get useAutoLayout(): boolean {
    return this._useAutoLayout;
  }

  protected set useAutoLayout(value: boolean) {
    if (this._useAutoLayout === value) {
      return;
    }
    this._useAutoLayout = value;
    try {
      localStorage.setItem('useAutoLayout', JSON.stringify(value));
    } catch {}
    if (value) {
      this.needsAdjust = true;
      this.pendingViewportReset = true;
    } else {
      this.recomputeMergedView();
    }
  }


  constructor(
    private missionState: MissionStateService,
    private stepsState: StepsStateService,
    private http: HttpService,
    private route: ActivatedRoute,
    private readonly history: FlowHistory,
    private translate: TranslateService
  ) {
    this.projectUUID = route.snapshot.paramMap.get('uuid');

    this.refreshContextMenuTemplates();
    this.updateOrientationOptions();
    this.langChangeSub = this.translate.onLangChange.subscribe(() => {
      this.refreshContextMenuTemplates();
      this.updateOrientationOptions();
    });

    this.historyManager = new FlowchartHistoryManager({
      missionState: this.missionState,
      history: this.history,
      missionNodes: this.missionNodes,
      missionConnections: this.missionConnections,
      adHocNodes: this.adHocNodes,
      adHocConnections: this.adHocConnections,
      comments: this.comments,
      nodes: this.nodes,
      connections: this.connections,
      recomputeMergedView: () => this.recomputeMergedView(),
      markNeedsAdjust: () => { this.needsAdjust = true; },
      markViewportResetPending: () => { this.pendingViewportReset = true; },
    });

    this.runManager = new FlowchartRunManager({
      http: this.http,
      isRunActive: this.isRunActive,
      getProjectUUID: () => this.projectUUID,
      getMissionKey: () => this.historyManager.getMissionKey(),
    });

    this.historyManager.resetHistoryWithCurrentState();
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
      if (!this.historyManager.shouldProcessMissionEffect()) {
        return;
      }

      const missionChanged = this.historyManager.prepareForMission(mission);
      if (missionChanged) {
        this.commentDraftTexts.clear();
      }

      if (mission) {
        this.rebuildFromMission(mission);
        this.needsAdjust = true;
      } else {
        this.historyManager.clearFlowState();
        this.pathToNodeId = new Map();
        this.pathToConnectionIds = new Map();
        this.runManager.updatePathLookups(this.pathToNodeId, this.pathToConnectionIds);
      }

      if (missionChanged) {
        this.historyManager.resetHistoryWithCurrentState();
      }
    });

    effect(() => {
      this.history.changes();
      if (!this.historyManager.isTraversingHistory()) {
        return;
      }
      this.historyManager.applySnapshotFromHistory();
    });
  }

  private refreshContextMenuTemplates(): void {
    const deleteLabel = this.translate.instant('COMMON.DELETE');
    const commentLabelRaw = this.translate.instant('FLOWCHART.COMMENT');
    const addCommentLabelRaw = this.translate.instant('FLOWCHART.ADD_COMMENT');
    const addCommentLabel = addCommentLabelRaw === 'FLOWCHART.ADD_COMMENT' ? 'Add Comment' : addCommentLabelRaw;
    const placeholderRaw = this.translate.instant('FLOWCHART.COMMENT_PLACEHOLDER');

    this.commentHeaderLabel = commentLabelRaw === 'FLOWCHART.COMMENT' ? 'Comment' : commentLabelRaw;
    this.commentPlaceholder = placeholderRaw === 'FLOWCHART.COMMENT_PLACEHOLDER' ? 'Write a comment...' : placeholderRaw;

    this.nodeContextMenuItems = [{
      label: deleteLabel,
      icon: 'pi pi-trash',
      command: () => this.deleteNode(),
    }];

    this.commentContextMenuItems = [{
      label: deleteLabel,
      icon: 'pi pi-trash',
      command: () => this.deleteComment(),
    }];

    this.canvasContextMenuItems = [{
      label: addCommentLabel,
      icon: 'pi pi-comment',
      command: () => this.createCommentFromContextMenu(),
    }];

    this.setContextMenuItems(this.nodeContextMenuItems);
  }

  private setContextMenuItems(items: MenuItem[]): void {
    this.items = [...items];
  }

  private updateOrientationOptions(): void {
    this.orientationOptions = [
      { label: this.translate.instant('FLOWCHART.ORIENTATION_VERTICAL'), value: 'vertical' as FlowOrientation },
      { label: this.translate.instant('FLOWCHART.ORIENTATION_HORIZONTAL'), value: 'horizontal' as FlowOrientation },
    ];
  }

  protected onOrientationChange(value: FlowOrientation | null): void {
    if (!value || value === this.orientation()) {
      return;
    }
    this.orientation.set(value);
    this.needsAdjust = true;
    this.pendingViewportReset = true;
  }

  protected isVerticalOrientation(): boolean {
    return this.orientation() === 'vertical';
  }

  protected startNodePosition(): { x: number; y: number } {
    if (this.isVerticalOrientation()) {
      return { x: 300, y: 0 };
    }
    const height = this.getNodeHeight(this.START_NODE);
    return { x: 0, y: 300 - height / 2 };
  }

  protected undo(): void {
    if (!this.canUndoSignal()) {
      return;
    }
    this.historyManager.beginHistoryTraversal();
    this.history.undo();
  }

  protected redo(): void {
    if (!this.canRedoSignal()) {
      return;
    }
    this.historyManager.beginHistoryTraversal();
    this.history.redo();
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

  private readStoredAutoLayout(): boolean {
    try {
      const stored = localStorage.getItem('useAutoLayout');
      return stored === null ? true : stored === 'true';
    } catch {
      return true;
    }
  }

  // ----- lifecycle -----
  ngAfterViewChecked(): void {
    if (!this.useAutoLayout) {
      return;
    }

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
    if (!this.useAutoLayout) {
      this.fCanvas()?.emitCanvasChangeEvent();
      this.syncCanvasTransform();
      return;
    }

    this.fCanvas()?.resetScaleAndCenter(false);
    this.fCanvas()?.emitCanvasChangeEvent();
    this.syncCanvasTransform();
  }

  // ----- dom helpers -----
  private heights(): Map<string, number> {
    const m = new Map<string, number>();
    this.nodeEls.forEach(el => {
      const id = el.nativeElement.dataset['nodeId'];
      if (id) m.set(id, el.nativeElement.offsetHeight || 80);
    });
    this.lastNodeHeights = m;
    return m;
  }

  private getNodeHeight(nodeId: string, fallback = 80): number {
    const cached = this.lastNodeHeights.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    let height = fallback;
    this.nodeEls.forEach(el => {
      const id = el.nativeElement.dataset['nodeId'];
      if (id === nodeId) {
        height = el.nativeElement.offsetHeight || fallback;
      }
    });
    this.lastNodeHeights.set(nodeId, height);
    return height;
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
    const setStepPosition = () => {
      if (this.useAutoLayout) {
        return;
      }
      const step = this.nodeIdToStep.get(nodeId);
      if (step) {
        step.position = { x: pos.x, y: pos.y };
      }
    };

    const upd = (sig: typeof this.adHocNodes | typeof this.missionNodes) => {
      const arr = sig();
      const i = arr.findIndex(n => n.id === nodeId);
      if (i < 0) return false;
      const next = arr.slice();
      next[i] = { ...next[i], position: { x: pos.x, y: pos.y } };
      sig.set(next);
      if (sig === this.missionNodes) {
        setStepPosition();
      }
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
    this.historyManager.recordHistory('move-node');
  }

  // ----- layout (transparent wrappers skipped) -----
  private autoLayout(): void {
    const mission = this.missionState.currentMission();
    const h = this.heights();
    const laneWidth = this.isVerticalOrientation()
      ? this.layoutSpacing.vertical.laneWidth
      : this.layoutSpacing.horizontal.laneWidth;
    const verticalGap = this.layoutSpacing.vertical.gap;
    const horizontalGap = this.layoutSpacing.horizontal.gap;
    const laidOut = computeAutoLayout(
      mission,
      this.nodes(),
      this.stepToNodeId,
      h,
      this.START_NODE,
      this.orientation(),
      laneWidth,
      verticalGap,
      horizontalGap
    );
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
    this.runManager.updatePathLookups(this.pathToNodeId, this.pathToConnectionIds);
    this.missionNodes.set(res.nodes);
    this.missionConnections.set(res.connections);
    this.recomputeMergedView();
    this.runManager.clearRunVisuals();
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

  isNodeCompleted(nodeId: string): boolean {
    return this.runManager.isNodeCompleted(nodeId);
  }

  isConnectionCompleted(connectionId: string): boolean {
    return this.runManager.isConnectionCompleted(connectionId);
  }

  onCreateNode(e: FCreateNodeEvent) {
    const step = e.data as Step;
    const args: Record<string, boolean | string | number | null> = {};
    step?.arguments?.forEach(a => args[a.name] = toVal(a.type, String((a.default ?? '') !== '' ? a.default : '')));
    this.adHocNodes.set([...this.adHocNodes(), {
      id: generateGuid(),
      text: step?.name ?? this.translate.instant('FLOWCHART.NEW_NODE'),
      position: e.rect,
      step,
      args
    }]);
    this.recomputeMergedView();
    this.needsAdjust = true;
    this.historyManager.recordHistory('create-node');
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
      this.historyManager.recordHistory('promote-node');
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
        this.historyManager.recordHistory('attach-to-start');
        return;
      }
    }

    // CHANGED: generated → ad-hoc attaches in PARALLEL after the source step
    if (srcStep && !dstStep && promote(dstId, srcStep)) return;

    // CHANGED: generated → generated attaches in PARALLEL
    if (srcStep && dstStep && attachChildWithParallel(mission, srcStep, dstStep)) {
      this.rebuildFromMission(mission);
      this.needsAdjust = true;
      this.historyManager.recordHistory('connect-existing-steps');
      return;
    }

    // fallback: just draw an ad-hoc wire
    this.adHocConnections.set([
      ...this.adHocConnections(),
      {id: generateGuid(), outputId: e.fOutputId, inputId: e.fInputId}
    ]);
    this.recomputeMergedView();
    this.historyManager.recordHistory('create-adhoc-connection');
  }


  // ----- comments -----
  onCanvasContextMenu(ev: MouseEvent): void {
    if ((ev.target as HTMLElement | null)?.closest('.node, .comment-node')) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    this.syncCanvasTransform();
    this.selectedNodeId = '';
    this.selectedCommentId = '';
    this.contextMenuEventPosition = { clientX: ev.clientX, clientY: ev.clientY };
    this.setContextMenuItems(this.canvasContextMenuItems);
    this.cm.show(ev);
  }

  onCommentRightClick(ev: MouseEvent, commentId: string): void {
    const target = ev.target as HTMLElement | null;
    if (target?.closest('.comment-text')) {
      ev.stopPropagation();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    this.syncCanvasTransform();
    this.selectedNodeId = '';
    this.selectedCommentId = commentId;
    this.contextMenuEventPosition = { clientX: ev.clientX, clientY: ev.clientY };
    this.setContextMenuItems(this.commentContextMenuItems);
    this.cm.show(ev);
  }

  protected onCommentTextChange(commentId: string, text: string): void {
    const comments = this.comments();
    const idx = comments.findIndex(c => c.id === commentId);
    if (idx === -1) {
      return;
    }
    const updated = comments.slice();
    updated[idx] = { ...updated[idx], text };
    this.comments.set(updated);
  }

  protected onCommentFocus(commentId: string): void {
    const comment = this.comments().find(c => c.id === commentId);
    if (!comment) {
      return;
    }
    this.commentDraftTexts.set(commentId, comment.text);
  }

  protected onCommentBlur(commentId: string): void {
    const initial = this.commentDraftTexts.get(commentId);
    const comment = this.comments().find(c => c.id === commentId);
    if (comment && initial !== undefined && initial !== comment.text) {
      this.historyManager.recordHistory('edit-comment');
    }
    this.commentDraftTexts.delete(commentId);
  }

  private createCommentFromContextMenu(): void {
    if (!this.contextMenuEventPosition) {
      return;
    }
    this.syncCanvasTransform();
    const position = this.toCanvasPoint(this.contextMenuEventPosition);
    this.addComment(position);
    this.cm.hide();
    this.contextMenuEventPosition = null;
  }

  private addComment(position: IPoint): void {
    const id = `comment-${generateGuid()}`;
    const newComment: FlowComment = { id, position: { x: position.x, y: position.y }, text: '' };
    this.comments.set([...this.comments(), newComment]);
    this.selectedCommentId = id;
    this.historyManager.recordHistory('create-comment');
    this.focusCommentTextarea(id);
  }

  protected onCommentPositionChanged(commentId: string, pos: IPoint): void {
    const comments = this.comments();
    const idx = comments.findIndex(c => c.id === commentId);
    if (idx === -1) {
      return;
    }
    const updated = comments.slice();
    updated[idx] = { ...updated[idx], position: { x: pos.x, y: pos.y } };
    this.comments.set(updated);
    this.historyManager.recordHistory('move-comment');
  }

  private deleteComment(): void {
    const id = this.selectedCommentId;
    if (!id) {
      return;
    }
    const before = this.comments().length;
    this.comments.set(this.comments().filter(c => c.id !== id));
    this.commentDraftTexts.delete(id);
    this.selectedCommentId = '';
    if (this.comments().length !== before) {
      this.historyManager.recordHistory('delete-comment');
    }
  }

  private toCanvasPoint(point: { clientX: number; clientY: number }): IPoint {
    const canvas = this.fCanvas();
    if (!canvas) {
      return { x: point.clientX, y: point.clientY };
    }
    const rect = canvas.hostElement.getBoundingClientRect();
    const transform = this.canvasTransform();
    const scale = transform.scale || 1;
    const offsetX = transform.position.x;
    const offsetY = transform.position.y;
    return {
      x: (point.clientX - rect.left - offsetX) / scale,
      y: (point.clientY - rect.top - offsetY) / scale,
    };
  }

  protected onCanvasTransformChange(event: FCanvasChangeEvent): void {
    this.canvasTransform.set({
      position: { x: event.position.x, y: event.position.y },
      scale: event.scale || 1,
    });
  }

  private focusCommentTextarea(id: string): void {
    setTimeout(() => {
      const ref = this.commentTextareas?.toArray().find(t => t.nativeElement.dataset['commentId'] === id);
      ref?.nativeElement.focus();
    }, 0);
  }

  private syncCanvasTransform(): void {
    const canvas = this.fCanvas();
    if (!canvas) {
      return;
    }
    const transform = canvas.transform;
    const pos = transform?.position ?? { x: 0, y: 0 };
    const scaled = transform?.scaledPosition ?? { x: 0, y: 0 };
    this.canvasTransform.set({
      position: {
        x: (pos.x ?? 0) + (scaled.x ?? 0),
        y: (pos.y ?? 0) + (scaled.y ?? 0),
      },
      scale: transform?.scale ?? 1,
    });
  }

  // ----- context menu -----
  onRightClick(ev: MouseEvent, nodeId: string) {
    ev.preventDefault();
    ev.stopPropagation();
    this.selectedNodeId = nodeId;
    this.selectedCommentId = '';
    this.contextMenuEventPosition = { clientX: ev.clientX, clientY: ev.clientY };
    this.setContextMenuItems(this.nodeContextMenuItems);
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

    this.selectedNodeId = '';
    this.needsAdjust = true;
    this.historyManager.recordHistory('delete-node');
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
      this.historyManager.recordHistory('split-adhoc-connection');
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
      this.historyManager.recordHistory('split-mission-connection');
    }
  }

  ngOnDestroy(): void {
    this.stopRun();
    this.langChangeSub?.unsubscribe();
  }

  onSave(): void {
    const mission = this.missionState.currentMission();
    if (mission == null || this.projectUUID == null) return
    this.http.saveMission(this.projectUUID, mission).subscribe(
      _ => {},
      error => {
        NotificationService.showError("Could not save settings", error.toString())
      }
    )
  }

  stopRun(): void {
    this.runManager.stopRun();
  }

  onRun(mode: 'normal' | 'debug'): void {
    this.runManager.onRun(mode);
  }
}
