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
  position: any;
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
  styleUrl: './flowchart.scss'
})
export class Flowchart implements AfterViewChecked {
  isDarkMode = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

  // merged state rendered by <f-flow>
  nodes = signal<FlowNode[]>([]);
  connections = signal<Connection[]>([]);

  // generated vs ad-hoc (user-added) layers
  private missionNodes = signal<FlowNode[]>([]);
  private missionConnections = signal<Connection[]>([]);
  private adHocNodes = signal<FlowNode[]>([]);
  private adHocConnections = signal<Connection[]>([]);

  // remember per-mission ad-hoc layer
  private adHocPerMission = new Map<string, { nodes: FlowNode[]; connections: Connection[] }>();
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

  items: MenuItem[] = [{ label: 'Delete', icon: 'pi pi-trash', command: () => this.deleteNode() }];

  constructor(private missionState: MissionStateService, private stepsState: StepsStateService) {
    effect(() => {
      const mission = this.missionState.currentMission();
      const newKey = mission ? ((mission as any).uuid ?? mission.name) : null;

      if (newKey !== this.currentMissionKey) {
        if (this.currentMissionKey)
          this.adHocPerMission.set(this.currentMissionKey, {
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

  ngAfterViewChecked(): void {
    if (!this.needsAdjust) return;
    this.needsAdjust = false;
    this.autoLayout();
  }

  onLoaded() {
    this.fCanvas()?.resetScaleAndCenter(false);
  }

  // ---------- Small helpers ----------
  private isParallel = (s?: MissionStep | null) =>
    !!s && ((s.function_name ?? '').toLowerCase() === 'parallel' || (s.step_type ?? '').toLowerCase() === 'parallel');
  private base = (id: string, suffix: 'input' | 'output') =>
    suffix === 'output'
      ? id === this.START_OUT
        ? this.START_NODE
        : id.replace(/-output$/, '')
      : id.replace(/-input$/, '');

  private heights(): Map<string, number> {
    const m = new Map<string, number>();
    this.nodeEls.forEach(el => {
      const id = el.nativeElement.dataset['nodeId'];
      if (id) m.set(id, el.nativeElement.offsetHeight || 80);
    });
    return m;
  }

  private cleanupAdHocNode(id: string) {
    const inputId = `${id}-input`;
    const outputId = `${id}-output`;
    this.adHocNodes.set(this.adHocNodes().filter(n => n.id !== id));
    this.adHocConnections.set(this.adHocConnections().filter(c => c.inputId !== inputId && c.outputId !== outputId));
  }

  private recomputeMergedView() {
    const allNodes = [...this.missionNodes(), ...this.adHocNodes()];
    const nodeIds = new Set(allNodes.map(n => n.id));
    const validIn = (id: string) => nodeIds.has(id.replace(/-input$/, ''));
    const validOut = (id: string) => id === this.START_OUT || nodeIds.has(id.replace(/-output$/, ''));
    const adhocConns = this.adHocConnections().filter(c => validOut(c.outputId) && validIn(c.inputId));
    this.nodes.set(allNodes);
    this.connections.set([...this.missionConnections(), ...adhocConns]);
  }

  // ---------- Node movement ----------
  onNodeMoved(nodeId: string, pos: IPoint) {
    const upd = (arr: FlowNode[]) =>
      arr.map(n => (n.id === nodeId ? { ...n, position: { x: pos.x, y: pos.y } } : n));
    const trySet = (sig: typeof this.adHocNodes | typeof this.missionNodes) => {
      const next = upd(sig());
      if (next !== sig()) {
        sig.set(next);
        this.recomputeMergedView();
        return true;
      }
      return false;
    };
    if (!trySet(this.adHocNodes)) trySet(this.missionNodes);
  }

  // ---------- Auto layout ----------
  private autoLayout() {
    const nodeHeights = this.heights();
    const startH = nodeHeights.get(this.START_NODE) ?? 80;
    let currentY = startH + 100;

    const newNodes = this.nodes().map(n => ({ ...n, position: { ...n.position } }));
    const setPos = (id: string, pos: { x: number; y: number }) => {
      const node = newNodes.find(n => n.id === id);
      if (node) node.position = pos;
    };

    const mission = this.missionState.currentMission();
    if (mission) {
      for (const s of mission.steps) {
        const res = this.layoutSubtree([s], { x: 300, y: currentY }, 200, 100, setPos, nodeHeights);
        currentY = res.maxY + 100;
      }
    }
    this.nodes.set(newNodes);
  }

  private layoutSubtree(
    steps: MissionStep[],
    start: { x: number; y: number },
    w: number,
    vGap: number,
    setPos: (id: string, p: { x: number; y: number }) => void,
    hMap: Map<string, number>
  ): { maxY: number; width: number } {
    if (!steps.length) return { maxY: start.y, width: 0 };
    const heights = steps.map(s => (this.isParallel(s) ? 0 : hMap.get(this.stepToNodeId.get(s) ?? '') ?? 80));
    const maxH = Math.max(...heights, 0);
    const totalW = (steps.length - 1) * w;
    const startX = start.x - totalW / 2;

    let maxY = start.y;
    steps.forEach((s, i) => {
      const x = startX + i * w;
      if (this.isParallel(s)) {
        if (s.children?.length) {
          const r = this.layoutSubtree(s.children, { x, y: start.y + maxH + vGap }, w, vGap, setPos, hMap);
          maxY = Math.max(maxY, r.maxY);
        }
        return;
      }

      const nodeId = this.stepToNodeId.get(s);
      if (!nodeId) return;
      setPos(nodeId, { x, y: start.y });

      let curMaxY = start.y + (heights[i] || 0);
      if (s.children?.length) {
        const r = this.layoutSubtree(
          s.children,
          { x, y: start.y + Math.max(heights[i] || 0, maxH) + vGap },
          w,
          vGap,
          setPos,
          hMap
        );
        curMaxY = r.maxY;
      }
      maxY = Math.max(maxY, curMaxY);
    });

    return { maxY, width: totalW + w };
  }

  // ---------- Mission rebuild ----------
  private rebuildFromMission(mission: Mission) {
    const newNodes: FlowNode[] = [];
    const newConns: Connection[] = [];
    const oldMap = new Map(this.stepToNodeId);

    this.stepToNodeId = new Map();
    this.nodeIdToStep.clear();

    let exits: string[] = [this.START_OUT];
    for (const top of mission.steps) {
      const r = this.buildStable([top], exits, newNodes, newConns, oldMap);
      exits = r.exitIds;
    }

    this.missionNodes.set(newNodes);
    this.missionConnections.set(newConns);
    this.recomputeMergedView();
  }

  private buildStable(
    steps: MissionStep[],
    parentExits: string[],
    nodesOut: FlowNode[],
    connsOut: Connection[],
    old: Map<MissionStep, string>
  ): { entryIds: string[]; exitIds: string[] } {
    const entries: string[] = [];
    const exits: string[] = [];

    for (const s of steps) {
      if (this.isParallel(s)) {
        const { entryIds, exitIds } = this.buildStable(s.children ?? [], parentExits, nodesOut, connsOut, old);
        entries.push(...entryIds);
        exits.push(...exitIds);
        continue;
      }

      const nodeId = old.get(s) ?? generateGuid();
      this.stepToNodeId.set(s, nodeId);
      this.nodeIdToStep.set(nodeId, s);

      const inputId = `${nodeId}-input`;
      const outputId = `${nodeId}-output`;

      nodesOut.push({
        id: nodeId,
        text: s.function_name,
        position: { x: 0, y: 0 },
        step: this.asStep(s),
        args: this.initialArgs(s)
      });

      parentExits.forEach(pid => connsOut.push({ outputId: pid, inputId }));
      entries.push(inputId);

      const childExit = s.children?.length
        ? this.buildStable(s.children, [outputId], nodesOut, connsOut, old).exitIds
        : [outputId];
      exits.push(...childExit);
    }

    return { entryIds: entries, exitIds: exits };
  }

  // ---------- Node create / connect ----------
  onCreateNode(e: FCreateNodeEvent) {
    const step = e.data as Step;
    const args: Record<string, boolean | string | number | null> = {};
    step?.arguments?.forEach(a => {
      const d = a.default ?? '';
      const v = d !== '' ? d : '';
      args[a.name] = a.type === 'bool' ? String(v).toLowerCase() === 'true' : a.type === 'float' ? parseFloat(String(v)) || null : v;
    });

    this.adHocNodes.set([
      ...this.adHocNodes(),
      {
        id: generateGuid(),
        text: step?.name ?? 'New Node',
        position: e.rect,
        step,
        args
      }
    ]);

    this.recomputeMergedView();
    this.needsAdjust = true;
  }

  public addConnection(e: FCreateConnectionEvent): void {
    if (!e.fInputId) return;

    const srcId = this.base(e.fOutputId, 'output');
    const dstId = this.base(e.fInputId, 'input');
    const mission = this.missionState.currentMission();
    const srcStep = this.nodeIdToStep.get(srcId);
    const dstStep = this.nodeIdToStep.get(dstId);

    const promote = (adhocId: string, parent?: MissionStep) => {
      const n = this.adHocNodes().find(x => x.id === adhocId);
      if (!mission || !n) return false;
      const mStep = this.fromAdHoc(n);
      this.stepToNodeId.set(mStep, n.id); // keep visual continuity

      if (parent) this.attachChildWithParallel(mission, parent, mStep);
      else (mission.steps ??= []).push(mStep);

      this.cleanupAdHocNode(n.id);
      this.rebuildFromMission(mission);
      this.needsAdjust = true;
      return true;
    };

    if (mission && srcStep && !dstStep && promote(dstId, srcStep)) return; // generated -> ad-hoc
    if (mission && srcId === this.START_NODE && !dstStep && promote(dstId)) return; // start -> ad-hoc
    if (mission && srcStep && dstStep && this.attachChildWithParallel(mission, srcStep, dstStep)) {
      this.rebuildFromMission(mission);
      this.needsAdjust = true;
      return;
    }

    // fallback: keep as ad-hoc wire
    this.adHocConnections.set([...this.adHocConnections(), { outputId: e.fOutputId, inputId: e.fInputId }]);
    this.recomputeMergedView();
  }

  // ---------- Context menu ----------
  onRightClick(ev: MouseEvent, nodeId: string) {
    ev.preventDefault();
    this.selectedNodeId = nodeId;
    this.cm.show(ev);
  }

  deleteNode() {
    const id = this.selectedNodeId;
    if (!id) return;

    const step = this.nodeIdToStep.get(id);
    const mission = this.missionState.currentMission();

    if (step && mission) {
      // explicitly typed, self-recursive helper
      const rm = (arr?: MissionStep[]): MissionStep[] | undefined =>
        arr?.filter(s => s !== step)
          .map(s => ({ ...s, children: rm(s.children) ?? [] }));

      mission.steps = rm(mission.steps) ?? [];
      this.rebuildFromMission(mission);
    } else {
      this.cleanupAdHocNode(id);
      this.recomputeMergedView();
    }

    this.needsAdjust = true;
  }

  // ---------- Step ↔ UI translation ----------
  private asStep(ms: MissionStep): Step {
    const pool = this.stepsState.currentSteps() ?? [];
    const match = pool.find(s => s.name === ms.function_name);
    if (match) return match;

    return {
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

    const setVal = (type: string, raw: string) =>
      type === 'bool' ? raw.toLowerCase() === 'true' : type === 'float' ? parseFloat(raw) || null : raw;

    if (match)
      return Object.fromEntries(
        match.arguments.map((sa, i) => {
          const mv = ms.arguments[i]?.value ?? sa.default ?? '';
          return [sa.name, setVal(sa.type, String(mv))];
        })
      );

    return Object.fromEntries(
      ms.arguments.map((a, i) => {
        const name = a.name || `arg${i}`;
        return [name, setVal(a.type, String(a.value ?? ''))];
      })
    );
  }

  private ensureParallelUnder(parent: MissionStep): MissionStep {
    parent.children ??= [];
    if (!parent.children.length) {
      const p = this.newParallel();
      parent.children.push(p);
      return p;
    }
    if (this.isParallel(parent.children[0])) return parent.children[0];
    const p = this.newParallel();
    p.children = [...parent.children];
    parent.children = [p];
    return p;
  }

  private newParallel(): MissionStep {
    return { step_type: 'parallel', function_name: 'parallel', arguments: [], children: [] };
  }

  private detachEverywhere(mission: Mission, target: MissionStep, exceptParent?: MissionStep): void {
    mission.steps = (mission.steps ?? []).filter(s => s !== target);

    const walk = (parent: MissionStep) => {
      const children = parent.children ?? [];
      if (!children.length) return;

      parent.children = children.filter(child => {
        if (exceptParent && parent === exceptParent) {
          walk(child);
          return true;
        }
        if (child === target) return false;
        walk(child);
        return true;
      });
    };

    (mission.steps ?? []).forEach(walk);
  }


  private attachChildWithParallel(mission: Mission, parent: MissionStep, child: MissionStep): boolean {
    if (parent === child) return false;

    const alreadyChild = (p: MissionStep) => {
      const ch = p.children ?? [];
      if (ch.includes(child)) return true;
      const first = ch[0];
      return this.isParallel(first) && !!first.children?.includes(child);
    };
    if (alreadyChild(parent)) return false;

    this.detachEverywhere(mission, child, parent);
    const par = this.ensureParallelUnder(parent);
    par.children ??= [];
    if (!par.children.includes(child)) {
      par.children.push(child);
      return true;
    }
    return false;
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
}
