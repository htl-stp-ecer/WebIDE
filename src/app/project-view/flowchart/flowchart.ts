import {
  AfterViewChecked,
  Component,
  effect,
  QueryList,
  signal,
  viewChild,
  ViewChildren,
  ElementRef,
  ViewChild
} from '@angular/core';
import {
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

// Shared models and helpers
import { Connection, FlowNode, Step, lc, isType, mk, baseId, toVal } from './models';
import {
  attachToStartWithParallel,
  detachEverywhere,
  ensureParallelAfter,
  containsStep,
  findSeqContainerForEdge,
  normalize,
  attachChildWithParallel,
  findParentAndIndex,
  findNearestParallelAncestor,
} from './mission-utils';
import { computeAutoLayout } from './layout-utils';

@Component({
  selector: 'app-flowchart',
  imports: [FFlowComponent, FFlowModule, InputNumberModule, CheckboxModule, InputTextModule, ContextMenuModule, Tooltip, FormsModule],
  templateUrl: './flowchart.html',
  styleUrl: './flowchart.scss',
  standalone: true
})
export class Flowchart implements AfterViewChecked {
  readonly isDarkMode = matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

  // Rendered state for <f-flow>
  readonly nodes = signal<FlowNode[]>([]);
  readonly connections = signal<Connection[]>([]);

  // Mission vs ad-hoc layers
  private readonly missionNodes = signal<FlowNode[]>([]);
  private readonly missionConnections = signal<Connection[]>([]);
  private readonly adHocNodes = signal<FlowNode[]>([]);
  private readonly adHocConnections = signal<Connection[]>([]);

  // Per-mission ad-hoc memory
  private readonly adHocPerMission = new Map<string, { nodes: FlowNode[]; connections: Connection[] }>();
  private currentMissionKey: string | null = null;

  fCanvas = viewChild(FCanvasComponent);
  @ViewChildren('nodeElement') nodeEls!: QueryList<ElementRef<HTMLDivElement>>;
  @ViewChild('cm') cm!: ContextMenu;

  private readonly START_NODE = 'start-node' as const;
  private readonly START_OUT = 'start-node-output' as const;

  private stepToNodeId = new Map<MissionStep, string>();
  private nodeIdToStep = new Map<string, MissionStep>();
  private needsAdjust = false;
  private selectedNodeId = '';

  readonly items: MenuItem[] = [{label: 'Delete', icon: 'pi pi-trash', command: () => this.deleteNode()}];

  constructor(private missionState: MissionStateService, private stepsState: StepsStateService) {
    effect(() => {
      const mission = this.missionState.currentMission();
      const newKey = mission ? ((mission as any).uuid ?? mission.name) : null;

      if (newKey !== this.currentMissionKey) {
        if (this.currentMissionKey) this.adHocPerMission.set(this.currentMissionKey, {
          nodes: this.adHocNodes(),
          connections: this.adHocConnections()
        });
        const saved = newKey ? this.adHocPerMission.get(newKey) : null;
        this.adHocNodes.set(saved?.nodes ?? []);
        this.adHocConnections.set(saved?.connections ?? []);
        this.currentMissionKey = newKey;
      }

      if (mission) {
        this.rebuildFromMission(mission);
        this.needsAdjust = true;
      }
    });
  }

  // ----- lifecycle -----
  ngAfterViewChecked(): void {
    if (this.needsAdjust) {
      this.needsAdjust = false;
      this.autoLayout();
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
    if (!upd(this.adHocNodes)) upd(this.missionNodes);
    this.recomputeMergedView();
  }

  // ----- layout (transparent wrappers skipped) -----
  private autoLayout(): void {
    const mission = this.missionState.currentMission();
    const h = this.heights();
    const laidOut = computeAutoLayout(mission, this.nodes(), this.stepToNodeId, h, this.START_NODE);
    this.nodes.set(laidOut);
  }

  private rebuildFromMission(mission: Mission): void {
    console.log(mission);
    const nodes: FlowNode[] = [], conns: Connection[] = [], old = new Map(this.stepToNodeId);
    this.stepToNodeId = new Map();
    this.nodeIdToStep.clear();

    const build = (steps: MissionStep[], parentExits: string[]): { entryIds: string[]; exitIds: string[] } => {
      const entries: string[] = [], exits: string[] = [];
      for (const s of steps) {
        if (isType(s, 'seq')) {
          let incoming = parentExits, first: string[] = [], last: string[] = incoming;
          (s.children ?? []).forEach((ch, i) => {
            const r = build([ch], incoming);
            if (i === 0) first.push(...r.entryIds);
            incoming = last = r.exitIds;
          });
          if (first.length) entries.push(...first);
          exits.push(...(last.length ? last : parentExits));
          continue;
        }
        if (isType(s, 'parallel')) {
          const r = build(s.children ?? [], parentExits);
          entries.push(...r.entryIds);
          exits.push(...r.exitIds);
          continue;
        }

        const id = old.get(s) ?? generateGuid();
        this.stepToNodeId.set(s, id);
        this.nodeIdToStep.set(id, s);
        const inputId = `${id}-input`, outputId = `${id}-output`;
        nodes.push({
          id,
          text: s.function_name,
          position: {x: 0, y: 0},
          step: this.asStep(s),
          args: this.initialArgs(s)
        });
        parentExits.forEach(pid => conns.push({id: generateGuid(), outputId: pid, inputId}));
        const childExit = s.children?.length ? build(s.children, [outputId]).exitIds : [outputId];
        entries.push(inputId);
        exits.push(...childExit);
      }
      return {entryIds: entries, exitIds: exits};
    };

    let exits: string[] = [this.START_OUT];
    for (const top of mission.steps) exits = build([top], exits).exitIds;
    this.missionNodes.set(nodes);
    this.missionConnections.set(conns);
    this.recomputeMergedView();
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
  }

  addConnection(e: FCreateConnectionEvent): void {
    if (!e.fInputId) return;
    const mission = this.missionState.currentMission();
    if (!mission) return;

    const srcId = baseId(e.fOutputId, 'output');
    const dstId = baseId(e.fInputId, 'input');
    const srcStep = this.nodeIdToStep.get(srcId);
    const dstStep = this.nodeIdToStep.get(dstId);

    // CHANGED: when promoting an ad-hoc node under a generated parent, attach via PARALLEL
    const promote = (adhocId: string, parent?: MissionStep) => {
      const n = this.adHocNodes().find(x => x.id === adhocId);
      if (!n) return false;
      const mStep = this.fromAdHoc(n);
      this.stepToNodeId.set(mStep, n.id); // keep visual continuity

      if (parent) {
        attachChildWithParallel(mission, parent, mStep);   // <-- was attachChildWithSeq
      } else {
        (mission.steps ??= []).push(mStep);
      }

      this.cleanupAdHocNode(n.id);
      this.rebuildFromMission(mission);
      this.needsAdjust = true;
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
          const m = this.fromAdHoc(n);
          this.stepToNodeId.set(m, n.id);
          this.cleanupAdHocNode(n.id);
          return attachToStartWithParallel(mission, m);
        })())
      ) {
        this.rebuildFromMission(mission);
        this.needsAdjust = true;
        return;
      }
    }

    // CHANGED: generated → ad-hoc attaches in PARALLEL after the source step
    if (srcStep && !dstStep && promote(dstId, srcStep)) return;

    // CHANGED: generated → generated attaches in PARALLEL
    if (srcStep && dstStep && attachChildWithParallel(mission, srcStep, dstStep)) {
      this.rebuildFromMission(mission);
      this.needsAdjust = true;
      return;
    }

    // fallback: just draw an ad-hoc wire
    this.adHocConnections.set([
      ...this.adHocConnections(),
      {id: generateGuid(), outputId: e.fOutputId, inputId: e.fInputId}
    ]);
    this.recomputeMergedView();
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

    if (step && mission) {
      const remove = (arr?: MissionStep[]) => {
        if (!arr) return;
        for (let i = 0; i < arr.length;) {
          const s = arr[i];
          if (s === step) {
            arr.splice(i, 1);
            continue;
          }
          remove(s.children);
          i++;
        }
      };
      remove(mission.steps);
      normalize(mission, 'parallel');
      normalize(mission, 'seq');
      this.rebuildFromMission(mission);
    } else {
      this.cleanupAdHocNode(id);
      this.recomputeMergedView();
    }
    this.needsAdjust = true;
  }

  // ----- step ↔ UI -----
  private asStep(ms: MissionStep): Step {
    const pool = this.stepsState.currentSteps() ?? [];
    const match = pool.find(s => s.name === ms.function_name);
    return match ?? {
      name: ms.function_name,
      import: '',
      arguments: ms.arguments.map((a, i) => ({
        name: a.name || `arg${i}`,
        type: a.type,
        import: null,
        optional: false,
        default: a.value
      })),
      file: ''
    };
  }

  private initialArgs(ms: MissionStep): Record<string, boolean | string | number | null> {
    const pool = this.stepsState.currentSteps() ?? [], match = pool.find(s => s.name === ms.function_name);
    return match
      ? Object.fromEntries(match.arguments.map((sa, i) => [sa.name, toVal(sa.type, String(ms.arguments[i]?.value ?? sa.default ?? ''))]))
      : Object.fromEntries(ms.arguments.map((a, i) => [a.name || `arg${i}`, toVal(a.type, String(a.value ?? ''))]));
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
      midStep = this.fromAdHoc(n);
      this.stepToNodeId.set(midStep, n.id);
      this.cleanupAdHocNode(n.id);
    }
    if (midStep === parentStep || midStep === childStep) return;
    detachEverywhere(mission, midStep);

    if (this.insertBetween(mission, parentStep, childStep, midStep)) {
      this.rebuildFromMission(mission);
      this.needsAdjust = true;
    }
  }

  private insertBetween(mission: Mission, parent: MissionStep | null, child: MissionStep, mid: MissionStep): boolean {
    // 0) LANE → OUTSIDE: if `parent` is inside a PARALLEL and `child` is outside it,
    //    insert `mid` INTO THE LANE (wrap with SEQ or insert into existing lane SEQ).
    if (parent) {
      const parAncestor = findNearestParallelAncestor(mission, parent);
      if (parAncestor && !containsStep(parAncestor, child)) {
        const locPrev = findParentAndIndex(mission, parent);
        if (!locPrev) return false;

        const {parent: prevDirectParent, container, index} = locPrev;

        // If lane already has a SEQ, insert after `parent`
        if (prevDirectParent && isType(prevDirectParent, 'seq')) {
          prevDirectParent.children ??= [];
          prevDirectParent.children.splice(index + 1, 0, mid);
        } else {
          // Wrap the lane element with SEQ(parent, mid)
          const seq = mk('seq');
          seq.children = [parent, mid];
          container.splice(index, 1, seq);
        }
        return true;
      }
    }

    // 1) If prev & next are adjacent siblings inside a SEQ wrapper, insert into that SEQ
    if (parent) {
      const seqHit = findSeqContainerForEdge(mission.steps, parent, child);
      if (seqHit) {
        seqHit.seq.children ??= [];
        seqHit.seq.children.splice(seqHit.nextIndex, 0, mid);
        return true;
      }
    }

    // 2) Top-level
    if (!parent) {
      const i = (mission.steps ?? []).indexOf(child);
      if (i === -1) return false;
      mission.steps.splice(i, 1, mid);
      mid.children = [child];
      return true;
    }

    // 3) Parent has single SEQ child and edge is inside that SEQ (legacy fast-path)
    if (parent.children?.length === 1 && isType(parent.children[0], 'seq')) {
      const seq = parent.children[0];
      seq.children ??= [];
      const k = seq.children.indexOf(child);
      if (k !== -1) {
        seq.children.splice(k, 0, mid);
        return true;
      }
    }

    // 4) Direct child of parent
    if (parent.children?.length) {
      const j = parent.children.indexOf(child);
      if (j !== -1) {
        parent.children.splice(j, 1, mid);
        mid.children = [child];
        return true;
      }
    }

    // 5) Fallbacks (now lane-aware via ensureParallelAfter)
    const par = ensureParallelAfter(mission, parent);
    par.children ??= [];
    const k = par.children.indexOf(child);
    if (k !== -1) {
      par.children.splice(k, 1, mid);
      mid.children = [child];
      return true;
    }

    const walk = (arr?: MissionStep[]): boolean => {
      if (!arr) return false;
      const i = arr.indexOf(child);
      if (i !== -1) {
        arr.splice(i, 1, mid);
        return true;
      }
      return arr.some(s => walk(s.children));
    };
    if (walk(mission.steps)) {
      mid.children = [child];
      return true;
    }

    return false;
  }

  // ----- normalize wrappers (parallel & seq) -----
  // normalize now imported from mission-utils

  // ----- conversions -----
  private fromAdHoc(n: FlowNode): MissionStep {
    const args = Object.entries(n.args || {}).map(([name, v]) => ({
      name,
      value: v == null ? '' : String(v),
      type: n.step?.arguments?.find(a => a.name === name)?.type ?? 'str'
    }));
    return {
      step_type: lc(n.step?.name) === 'parallel' ? 'parallel' : '',
      function_name: n.step?.name || n.text,
      arguments: args,
      children: []
    };
  }

  // attachChildWithParallel now imported from mission-utils


  // findParentAndIndex, findNearestParallelAncestor now imported from mission-utils
}
