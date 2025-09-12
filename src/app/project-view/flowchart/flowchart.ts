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
  FFlowModule
} from '@foblex/flow';
import { IPoint } from '@foblex/2d';
import { generateGuid } from '@foblex/utils';
import { InputNumberModule } from 'primeng/inputnumber';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { MissionStateService } from '../../services/mission-sate-service';
import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { StepsStateService } from '../../services/steps-state-service';
import { ContextMenuModule } from 'primeng/contextmenu';
import { ContextMenu } from 'primeng/contextmenu';
import { MenuItem } from 'primeng/api';
import { Tooltip } from 'primeng/tooltip';
import { FormsModule } from '@angular/forms';
type Connection = { outputId: string; inputId: string };
interface FlowNode {
  id: string;
  text: string;
  position: { x: number; y: number };
  step: Step;
  args: Record<string, boolean | string | number | null>;
}
@Component({
  selector: 'app-flowchart',
  imports: [
    FFlowComponent,
    FFlowModule,
    InputNumberModule,
    CheckboxModule,
    InputTextModule,
    ContextMenuModule,
    Tooltip,
    FormsModule
  ],
  templateUrl: './flowchart.html',
  styleUrl: './flowchart.scss',
  standalone: true
})
export class Flowchart implements AfterViewChecked {
  readonly isDarkMode = matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  // Rendered state for <f-flow>
  readonly nodes = signal<FlowNode[]>([]);
  readonly connections = signal<Connection[]>([]);
  // Generated (mission) vs. ad-hoc layers
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
  readonly items: MenuItem[] = [{ label: 'Delete', icon: 'pi pi-trash', command: () => this.deleteNode() }];
  constructor(private missionState: MissionStateService, private stepsState: StepsStateService) {
    effect(() => {
      const mission = this.missionState.currentMission();
      const newKey = mission ? ((mission as any).uuid ?? mission.name) : null;
      // swap ad-hoc layer when mission changes
      if (newKey !== this.currentMissionKey) {
        if (this.currentMissionKey)
          this.adHocPerMission.set(this.currentMissionKey, { nodes: this.adHocNodes(), connections: this.adHocConnections() });
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
  // --- lifecycle ---
  ngAfterViewChecked(): void {
    if (!this.needsAdjust) return;
    this.needsAdjust = false;
    this.autoLayout();
  }
  onLoaded() { this.fCanvas()?.resetScaleAndCenter(false); }
  // --- tiny utils ---
  private isParallel = (s?: MissionStep | null) =>
    !!s && ((s.function_name ?? '').toLowerCase() === 'parallel' || (s.step_type ?? '').toLowerCase() === 'parallel');
  private base(id: string, kind: 'input' | 'output') {
    return kind === 'output' ? (id === this.START_OUT ? this.START_NODE : id.replace(/-output$/, '')) : id.replace(/-input$/, '');
  }
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
    const validIn = (x: string) => ids.has(x.replace(/-input$/, ''));
    const validOut = (x: string) => x === this.START_OUT || ids.has(x.replace(/-output$/, ''));
    const adhocConns = this.adHocConnections().filter(c => validOut(c.outputId) && validIn(c.inputId));
    this.nodes.set(allNodes);
    this.connections.set([...this.missionConnections(), ...adhocConns]);
  }
  // --- movement ---
  onNodeMoved(nodeId: string, pos: IPoint) {
    const update = (sig: typeof this.adHocNodes | typeof this.missionNodes) => {
      const arr = sig(); const i = arr.findIndex(n => n.id === nodeId);
      if (i < 0) return false;
      const next = arr.slice(); next[i] = { ...next[i], position: { x: pos.x, y: pos.y } };
      sig.set(next); return true;
    };
    if (!update(this.adHocNodes)) update(this.missionNodes);
    this.recomputeMergedView();
  }
  // --- layout (hidden "parallel" is skipped visually) ---
  private autoLayout(): void {
    const h = this.heights();
    const newNodes = this.nodes().map(n => ({ ...n, position: { ...n.position } }));
    const setPos = (id: string, p: { x: number; y: number }) => {
      const idx = newNodes.findIndex(n => n.id === id); if (idx > -1) newNodes[idx] = { ...newNodes[idx], position: p };
    };
    const mission = this.missionState.currentMission(); if (!mission) return;
    let y = (h.get(this.START_NODE) ?? 80) + 100;
    const layoutSubtree = (
      steps: MissionStep[],
      start: { x: number; y: number },
      w: number,
      vGap: number
    ): { maxY: number } => {
      if (!steps.length) return { maxY: start.y };
      const nh = (s: MissionStep) => (this.isParallel(s) ? 0 : h.get(this.stepToNodeId.get(s) ?? '') ?? 80);
      const hs = steps.map(nh), maxH = Math.max(0, ...hs), totalW = (steps.length - 1) * w, x0 = start.x - totalW / 2;
      let maxY = start.y;
      steps.forEach((s, i) => {
        const x = x0 + i * w;
        if (this.isParallel(s)) {
          if (s.children?.length) maxY = Math.max(maxY, layoutSubtree(s.children, { x, y: start.y }, w, vGap).maxY);
          return;
        }
        const id = this.stepToNodeId.get(s); if (id) setPos(id, { x, y: start.y });
        const belowY = start.y + Math.max(hs[i] || 0, maxH) + vGap;
        if (s.children?.length) maxY = Math.max(maxY, layoutSubtree(s.children, { x, y: belowY }, w, vGap).maxY);
        else maxY = Math.max(maxY, start.y + (hs[i] || 0));
      });
      return { maxY };
    };
    for (const s of mission.steps) {
      const r = layoutSubtree([s], { x: 300, y }, 200, 100);
      y = r.maxY + 100;
    }
    this.nodes.set(newNodes);
  }
  // --- mission rebuild (skips visual "parallel" nodes) ---
  private rebuildFromMission(mission: Mission): void {
    const nodes: FlowNode[] = [], conns: Connection[] = [];
    const old = new Map(this.stepToNodeId);
    this.stepToNodeId = new Map(); this.nodeIdToStep.clear();
    const build = (
      steps: MissionStep[],
      parentExits: string[]
    ): { entryIds: string[]; exitIds: string[] } => {
      const entries: string[] = [], exits: string[] = [];
      for (const s of steps) {
        if (this.isParallel(s)) {
          const r = build(s.children ?? [], parentExits);
          entries.push(...r.entryIds); exits.push(...r.exitIds); continue;
        }
        const id = old.get(s) ?? generateGuid();
        this.stepToNodeId.set(s, id); this.nodeIdToStep.set(id, s);
        const inputId = `${id}-input`, outputId = `${id}-output`;
        nodes.push({ id, text: s.function_name, position: { x: 0, y: 0 }, step: this.asStep(s), args: this.initialArgs(s) });
        parentExits.forEach(pid => conns.push({ outputId: pid, inputId }));
        entries.push(inputId);
        const childExit = s.children?.length ? build(s.children, [outputId]).exitIds : [outputId];
        exits.push(...childExit);
      }
      return { entryIds: entries, exitIds: exits };
    };
    let exits: string[] = [this.START_OUT];
    for (const top of mission.steps) exits = build([top], exits).exitIds;
    this.missionNodes.set(nodes);
    this.missionConnections.set(conns);
    this.recomputeMergedView();
  }
  // --- create / connect ---
  onCreateNode(e: FCreateNodeEvent) {
    const step = e.data as Step;
    const toVal = (t: string, v: string) => (t === 'bool' ? v.toLowerCase() === 'true' : t === 'float' ? (parseFloat(v) || null) : v);
    const args: Record<string, boolean | string | number | null> = {};
    step?.arguments?.forEach(a => {
      const d = a.default ?? '';
      args[a.name] = toVal(a.type, String(d !== '' ? d : ''));
    });
    this.adHocNodes.set([...this.adHocNodes(), { id: generateGuid(), text: step?.name ?? 'New Node', position: e.rect, step, args }]);
    this.recomputeMergedView(); this.needsAdjust = true;
  }
  addConnection(e: FCreateConnectionEvent): void {
    if (!e.fInputId) return;
    const mission = this.missionState.currentMission(); if (!mission) return;
    const srcId = this.base(e.fOutputId, 'output'), dstId = this.base(e.fInputId, 'input');
    const srcStep = this.nodeIdToStep.get(srcId), dstStep = this.nodeIdToStep.get(dstId);
    const promote = (adhocId: string, parent?: MissionStep) => {
      const n = this.adHocNodes().find(x => x.id === adhocId); if (!n) return false;
      const mStep = this.fromAdHoc(n);
      this.stepToNodeId.set(mStep, n.id); // keep visual continuity
      parent ? this.attachChildWithParallel(mission, parent, mStep) : (mission.steps ??= []).push(mStep);
      this.cleanupAdHocNode(n.id); this.rebuildFromMission(mission); this.needsAdjust = true; return true;
    };
    if (srcStep && !dstStep && promote(dstId, srcStep)) return; // generated → ad-hoc
    if (srcId === this.START_NODE && !dstStep && promote(dstId)) return; // start → ad-hoc
    if (srcStep && dstStep && this.attachChildWithParallel(mission, srcStep, dstStep)) {
      this.rebuildFromMission(mission); this.needsAdjust = true; return;
    }
    // fallback: keep as ad-hoc wire
    this.adHocConnections.set([...this.adHocConnections(), { outputId: e.fOutputId, inputId: e.fInputId }]);
    this.recomputeMergedView();
  }
  // --- context menu ---
  onRightClick(ev: MouseEvent, nodeId: string) {
    ev.preventDefault();
    this.selectedNodeId = nodeId;
    this.cm.show(ev);
  }
  deleteNode(): void {
    const id = this.selectedNodeId; if (!id) return;
    const step = this.nodeIdToStep.get(id);
    const mission = this.missionState.currentMission();
    if (step && mission) {
      const rm = (arr?: MissionStep[]): MissionStep[] | undefined =>
        arr?.filter(s => s !== step).map(s => ({ ...s, children: rm(s.children) ?? [] }));
      mission.steps = rm(mission.steps) ?? [];
      this.rebuildFromMission(mission);
    } else {
      this.cleanupAdHocNode(id); this.recomputeMergedView();
    }
    this.needsAdjust = true;
  }
  // --- step ↔ UI ---
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
    const pool = this.stepsState.currentSteps() ?? [];
    const match = pool.find(s => s.name === ms.function_name);
    const toVal = (t: string, v: string) => (t === 'bool' ? v.toLowerCase() === 'true' : t === 'float' ? (parseFloat(v) || null) : v);
    if (match)
      return Object.fromEntries(
        match.arguments.map((sa, i) => [sa.name, toVal(sa.type, String(ms.arguments[i]?.value ?? sa.default ?? ''))])
      );
    return Object.fromEntries(ms.arguments.map((a, i) => [a.name || `arg${i}`, toVal(a.type, String(a.value ?? ''))]));
  }
  // --- parallel management ---
  private ensureParallelUnder(parent: MissionStep): MissionStep {
    parent.children ??= [];

    if (!parent.children.length) return parent.children[0] = this.newParallel();
    if (this.isParallel(parent.children[0])) return parent.children[0];

    const p = this.newParallel(); p.children = [...parent.children]; parent.children = [p]; return p;
  }
  private newParallel(): MissionStep {
    return { step_type: 'parallel', function_name: 'parallel', arguments: [], children: [] };
  }
  private detachEverywhere(mission: Mission, target: MissionStep, exceptParent?: MissionStep): void {
    mission.steps = (mission.steps ?? []).filter(s => s !== target);
    const walk = (parent: MissionStep): void => {
      const children = parent.children ?? []; if (!children.length) return;
      parent.children = children.filter(ch => (exceptParent && parent === exceptParent) || ch !== target);
      (parent.children ?? []).forEach(walk);
    };
    (mission.steps ?? []).forEach(walk);
  }
  private attachChildWithParallel(mission: Mission, parent: MissionStep, child: MissionStep): boolean {
    if (parent === child) return false;
    const effective = this.getEffectiveChildren(mission, parent);
    if (effective.includes(child)) return false;
    for (const missionStep of effective) {
      this.detachEverywhere(mission, missionStep, parent);
      const par = this.ensureParallelUnder(parent);
      par.children ??= [];
      const uniq = new Set<MissionStep>([...par.children, ...effective]);
      uniq.add(child);
      par.children = Array.from(uniq);
    }
    return true;
  }
  private fromAdHoc(n: FlowNode): MissionStep {
    const args = Object.entries(n.args || {}).map(([name, v]) => ({
      name,
      value: v == null ? '' : String(v),
      type: n.step?.arguments?.find(a => a.name === name)?.type ?? 'str'
    }));
    return {
      step_type: (n.step?.name ?? '').toLowerCase() === 'parallel' ? 'parallel' : '',
      function_name: n.step?.name || n.text,
      arguments: args,
      children: []
    };
  }
  private promoteAdHocByNodeId(mission: Mission, nodeId: string): MissionStep | null {
    const n = this.adHocNodes().find(x => x.id === nodeId);
    if (!n) return null;
    const mStep = this.fromAdHoc(n);
    // keep visual continuity
    this.stepToNodeId.set(mStep, n.id);
    // remove the ad-hoc shadow (node + its wires)
    this.cleanupAdHocNode(n.id);
    // make it exist in the mission (temporarily as top-level; we'll reattach below)
    (mission.steps ??= []).push(mStep);
    return mStep;
  }
  private getEffectiveChildren(mission: Mission, parent: MissionStep): MissionStep[] {
    const set = new Set<MissionStep>();
    // 1) structure-based
    const ch = parent.children ?? [];
    if (ch.length && this.isParallel(ch[0])) {
      (ch[0].children ?? []).forEach(c => set.add(c));
    } else {
      ch.forEach(c => set.add(c));
    }
    // 2) wire-based
    const parentId = this.stepToNodeId.get(parent);
    if (parentId) {
      const merged = [...this.missionConnections(), ...this.adHocConnections()];
      const wiredIns = merged.filter(c => this.base(c.outputId, 'output') === parentId).map(c => this.base(c.inputId, 'input'));
      for (const inNodeId of wiredIns) {
        const wiredStep = this.nodeIdToStep.get(inNodeId);
        if (wiredStep) {
          set.add(wiredStep);
          console.log("wired")
        } else {
          // If it's an ad-hoc node, promote it so we can treat it as a real child
          const promoted = this.promoteAdHocByNodeId(mission, inNodeId);
          if (promoted) set.add(promoted);
          console.log("promoted")
        }
      }
    }
    return Array.from(set);
  }
}
