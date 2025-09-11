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
import {FormsModule} from '@angular/forms';

interface FlowNode {
  id: string;
  text: string;
  position: any;
  step: Step;
  args: { [key: string]: boolean | string | number | null };
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
  isDarkMode =
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  nodes = signal<FlowNode[]>([]);
  connections = signal<{ outputId: string; inputId: string }[]>([]);

  private missionNodes = signal<FlowNode[]>([]);
  private missionConnections = signal<{ outputId: string; inputId: string }[]>([]);
  private adHocNodes = signal<FlowNode[]>([]);
  private adHocConnections = signal<{ outputId: string; inputId: string }[]>([]);

  private adHocPerMission = new Map<
    string,
    { nodes: FlowNode[]; connections: { outputId: string; inputId: string }[] }
  >();
  private currentMissionKey: string | null = null;

  fCanvas = viewChild(FCanvasComponent);

  private readonly startNodeId = 'start-node';
  private readonly startOutputId = 'start-node-output';

  private stepToNodeId: Map<MissionStep, string> = new Map();
  private nodeIdToStep: Map<string, MissionStep> = new Map();

  private needsAdjust = false;

  @ViewChildren('nodeElement') nodeElements!: QueryList<ElementRef<HTMLDivElement>>;
  @ViewChild('cm') cm!: ContextMenu;

  items: MenuItem[] = [{ label: 'Delete', icon: 'pi pi-trash', command: () => this.deleteNode() }];

  private selectedNodeId: string = '';

  constructor(private missionState: MissionStateService, private stepsState: StepsStateService) {
    effect(() => {
      const mission = this.missionState.currentMission();
      const newKey = mission ? this.missionKey(mission) : null;

      if (newKey !== this.currentMissionKey) {
        if (this.currentMissionKey) {
          this.adHocPerMission.set(this.currentMissionKey, {
            nodes: this.adHocNodes(),
            connections: this.adHocConnections(),
          });
        }

        if (newKey && this.adHocPerMission.has(newKey)) {
          const saved = this.adHocPerMission.get(newKey)!;
          this.adHocNodes.set(saved.nodes);
          this.adHocConnections.set(saved.connections);
        } else {
          this.adHocNodes.set([]);
          this.adHocConnections.set([]);
        }

        this.currentMissionKey = newKey;
      }

      if (mission) {
        this.generateStructure(mission);
        this.needsAdjust = true;
      }
    });
  }

  private missionKey(m: Mission): string {
    return (m as any).uuid ?? m.name;
  }

  ngAfterViewChecked(): void {
    if (this.needsAdjust) {
      this.needsAdjust = false;
      this.adjustPositions();
    }
  }

  onLoaded() {
    this.fCanvas()?.resetScaleAndCenter(false);
  }

  onNodeMoved(nodeId: string, pos: IPoint) {
    const updatedAdHoc = this.adHocNodes().map(n =>
      n.id === nodeId ? { ...n, position: { x: pos.x, y: pos.y } } : n
    );
    if (updatedAdHoc !== this.adHocNodes()) {
      this.adHocNodes.set(updatedAdHoc);
      this.recomputeMergedView();
      return;
    }

    const updatedMission = this.missionNodes().map(n =>
      n.id === nodeId ? { ...n, position: { x: pos.x, y: pos.y } } : n
    );
    if (updatedMission !== this.missionNodes()) {
      this.missionNodes.set(updatedMission);
      this.recomputeMergedView();
    }
  }

  private getNodeHeights(): Map<string, number> {
    const heights = new Map<string, number>();
    this.nodeElements.forEach((el) => {
      const id = el.nativeElement.dataset['nodeId'];
      if (id) heights.set(id, el.nativeElement.offsetHeight);
    });
    return heights;
  }

  private adjustPositions(): void {
    const nodeHeights = this.getNodeHeights();
    const startHeight = nodeHeights.get(this.startNodeId) ?? 80;

    let currentY = startHeight + 100;

    const newNodes = this.nodes().map((n) => ({ ...n, position: { ...n.position } }));

    const updatePosition = (id: string, pos: { x: number; y: number }) => {
      const node = newNodes.find((n) => n.id === id);
      if (node) node.position = pos;
    };

    const mission = this.missionState.currentMission();
    if (mission) {
      for (const missionStep of mission.steps) {
        const startPos = { x: 300, y: currentY };
        const res = this.assignPositions(
          [missionStep],
          startPos,
          200,
          100,
          updatePosition,
          nodeHeights
        );
        currentY = res.maxY + 100;
      }
    }

    this.nodes.set(newNodes);
  }

  private assignPositions(
    missionSteps: MissionStep[],
    startPosition: { x: number; y: number },
    nodeWidth: number,
    verticalSpacing: number,
    updatePosition: (id: string, pos: { x: number; y: number }) => void,
    nodeHeights: Map<string, number>
  ): { maxY: number; width: number } {
    if (missionSteps.length === 0) return { maxY: startPosition.y, width: 0 };

    // Compute heights for visible nodes only; hidden ("parallel") steps have no node.
    const siblingHeights = missionSteps.map((step) => {
      if (this.isParallel(step)) return 0; // treat as transparent for height
      const nodeId = this.stepToNodeId.get(step);
      return nodeId ? nodeHeights.get(nodeId) ?? 80 : 80;
    });

    const maxSiblingHeight = Math.max(...siblingHeights, 0);
    const totalWidth = (missionSteps.length - 1) * nodeWidth;
    const startX = startPosition.x - totalWidth / 2;

    let maxY = startPosition.y;

    for (let i = 0; i < missionSteps.length; i++) {
      const missionStep = missionSteps[i];

      if (this.isParallel(missionStep)) {
        if (missionStep.children && missionStep.children.length > 0) {
          const childPosition = {
            x: startX + i * nodeWidth,
            y: startPosition.y + maxSiblingHeight + verticalSpacing
          };
          const childResult = this.assignPositions(
            missionStep.children,
            childPosition,
            nodeWidth,
            verticalSpacing,
            updatePosition,
            nodeHeights
          );
          maxY = Math.max(maxY, childResult.maxY);
        }
        continue;
      }

      const nodeId = this.stepToNodeId.get(missionStep);
      if (!nodeId) continue;

      const siblingX = startX + i * nodeWidth;
      const pos = { x: siblingX, y: startPosition.y };
      updatePosition(nodeId, pos);

      const nodeHeight = siblingHeights[i] || 0;
      let currentMaxY = startPosition.y + nodeHeight;

      if (missionStep.children && missionStep.children.length > 0) {
        const childPosition = {
          x: siblingX,
          y: startPosition.y + Math.max(nodeHeight, maxSiblingHeight) + verticalSpacing
        };
        const childResult = this.assignPositions(
          missionStep.children,
          childPosition,
          nodeWidth,
          verticalSpacing,
          updatePosition,
          nodeHeights
        );
        currentMaxY = childResult.maxY;
      }

      maxY = Math.max(maxY, currentMaxY);
    }

    return { maxY, width: totalWidth + nodeWidth };
  }

  private generateStructure(mission: Mission) {
    const newMissionNodes: FlowNode[] = [];
    const newMissionConnections: { outputId: string; inputId: string }[] = [];

    const oldStepToNodeId = new Map(this.stepToNodeId);

    this.stepToNodeId = new Map();
    this.nodeIdToStep.clear();

    let previousExitIds: string[] = [this.startOutputId];

    for (const topStep of mission.steps) {
      const result = this.createNodesAndConnectionsStable(
        [topStep],
        previousExitIds,
        newMissionNodes,
        newMissionConnections,
        oldStepToNodeId
      );
      previousExitIds = result.exitIds;
    }

    this.missionNodes.set(newMissionNodes);
    this.missionConnections.set(newMissionConnections);

    this.recomputeMergedView();
  }

  private createNodesAndConnectionsStable(
    missionSteps: MissionStep[],
    parentExitIds: string[],
    nodesOut: FlowNode[],
    connsOut: { outputId: string; inputId: string }[],
    oldStepToNodeId: Map<MissionStep, string>
  ): { entryIds: string[]; exitIds: string[] } {
    const entryIds: string[] = [];
    const exitIds: string[] = [];

    for (const missionStep of missionSteps) {
      if (this.isParallel(missionStep)) {
        const children = missionStep.children ?? [];
        const forwarded = this.createNodesAndConnectionsStable(
          children,
          parentExitIds,
          nodesOut,
          connsOut,
          oldStepToNodeId
        );
        entryIds.push(...forwarded.entryIds);
        exitIds.push(...forwarded.exitIds);
        continue;
      }

      // visible step
      const nodeId = oldStepToNodeId.get(missionStep) ?? generateGuid();
      this.stepToNodeId.set(missionStep, nodeId);
      this.nodeIdToStep.set(nodeId, missionStep);

      const inputId = `${nodeId}-input`;
      const outputId = `${nodeId}-output`;

      const node: FlowNode = {
        id: nodeId,
        text: missionStep.function_name,
        position: { x: 0, y: 0 },
        step: this.convertMissionStepToStep(missionStep),
        args: this.initializeArgs(missionStep)
      };
      nodesOut.push(node);

      for (const parentExitId of parentExitIds) {
        connsOut.push({ outputId: parentExitId, inputId });
      }

      entryIds.push(inputId);

      let currentExitIds: string[] = [outputId];
      if (missionStep.children && missionStep.children.length > 0) {
        const childResult = this.createNodesAndConnectionsStable(
          missionStep.children,
          [outputId],
          nodesOut,
          connsOut,
          oldStepToNodeId
        );
        currentExitIds = childResult.exitIds;
      }
      exitIds.push(...currentExitIds);
    }

    return { entryIds, exitIds };
  }

  onCreateNode(event: FCreateNodeEvent) {
    const step = event.data as Step;
    const args: { [key: string]: boolean | string | number | null } = {};

    step?.arguments?.forEach((arg) => {
      if (arg.default !== null && arg.default !== '') {
        if (arg.type === 'bool') {
          args[arg.name] = arg.default.toLowerCase() === 'true';
        } else if (arg.type === 'float') {
          args[arg.name] = parseFloat(arg.default) || null;
        } else {
          args[arg.name] = arg.default;
        }
      } else {
        args[arg.name] = arg.type === 'bool' ? false : arg.type === 'float' ? null : '';
      }
    });

    const id = generateGuid();

    const newNode: FlowNode = {
      id,
      text: step?.name ?? 'New Node',
      position: event.rect,
      step: step,
      args
    };

    this.adHocNodes.set([...this.adHocNodes(), newNode]);
    this.recomputeMergedView();
    this.needsAdjust = true;
  }

  public addConnection(event: FCreateConnectionEvent): void {
    if (!event.fInputId) return;

    const srcBaseId = this.baseFromOutputId(event.fOutputId);
    const dstBaseId = this.baseFromInputId(event.fInputId);

    const mission = this.missionState.currentMission();

    const srcStep = this.nodeIdToStep.get(srcBaseId);
    const dstStep = this.nodeIdToStep.get(dstBaseId);

    // A) generated -> ad-hoc  ==> promote ad-hoc into mission under srcStep
    if (mission && srcStep && !dstStep) {
      const adhoc = this.adHocNodes().find(n => n.id === dstBaseId);
      if (adhoc) {
        const promoted = this.missionStepFromAdHoc(adhoc);

        // Reuse the ad-hoc node's id during regeneration for visual continuity
        this.stepToNodeId.set(promoted, adhoc.id);

        // Attach under the source (handles parallel fan-out internally)
        this.attachChildWithParallel(mission, srcStep, promoted);

        // Remove ad-hoc node + any ad-hoc connections touching it
        const inputId = `${adhoc.id}-input`;
        const outputId = `${adhoc.id}-output`;
        this.adHocConnections.set(
          this.adHocConnections().filter(c => c.inputId !== inputId && c.outputId !== outputId)
        );
        this.adHocNodes.set(this.adHocNodes().filter(n => n.id !== adhoc.id));

        // Rebuild graph & auto-layout
        this.generateStructure(mission);
        this.needsAdjust = true;
        return;
      }
    }

    // B) Start -> ad-hoc  ==> promote as new top-level mission step
    if (mission && srcBaseId === this.startNodeId && !dstStep) {
      const adhoc = this.adHocNodes().find(n => n.id === dstBaseId);
      if (adhoc) {
        const promoted = this.missionStepFromAdHoc(adhoc);

        // Reuse id
        this.stepToNodeId.set(promoted, adhoc.id);

        // Append to top-level mission steps
        mission.steps = mission.steps ?? [];
        mission.steps.push(promoted);

        // Clean up ad-hoc copies
        const inputId = `${adhoc.id}-input`;
        const outputId = `${adhoc.id}-output`;
        this.adHocConnections.set(
          this.adHocConnections().filter(c => c.inputId !== inputId && c.outputId !== outputId)
        );
        this.adHocNodes.set(this.adHocNodes().filter(n => n.id !== adhoc.id));

        // Rebuild & auto-layout
        this.generateStructure(mission);
        this.needsAdjust = true;
        return;
      }
    }

    // C) generated -> generated  ==> your existing "attach with parallel"
    if (mission && srcStep && dstStep) {
      const changed = this.attachChildWithParallel(mission, srcStep, dstStep);
      if (changed) {
        this.generateStructure(mission);
        this.needsAdjust = true;
        return;
      }
    }

    // Fallback: keep as ad-hoc connection
    this.adHocConnections.set([
      ...this.adHocConnections(),
      { outputId: event.fOutputId, inputId: event.fInputId }
    ]);
    this.recomputeMergedView();
  }


  onRightClick(event: MouseEvent, nodeId: string) {
    event.preventDefault();
    this.selectedNodeId = nodeId;
    this.cm.show(event);
  }

  deleteNode() {
    const nodeId = this.selectedNodeId;
    if (!nodeId) return;

    const stepToRemove = this.nodeIdToStep.get(nodeId);

    if (stepToRemove) {
      this.removeStepFromMission(stepToRemove);
      const mission = this.missionState.currentMission();
      if (mission) this.generateStructure(mission);
    } else {
      this.adHocNodes.set(this.adHocNodes().filter((n) => n.id !== nodeId));

      const inputId = `${nodeId}-input`;
      const outputId = `${nodeId}-output`;

      this.adHocConnections.set(
        this.adHocConnections().filter((c) => c.outputId !== outputId && c.inputId !== inputId)
      );

      this.recomputeMergedView();
    }

    this.needsAdjust = true;
  }

  private removeStepFromMission(stepToRemove: MissionStep) {
    const mission = this.missionState.currentMission();
    if (!mission) return;

    mission.steps = mission.steps.filter((s) => s !== stepToRemove);
    for (const step of mission.steps) {
      this.removeStepFromChildren(step, stepToRemove);
    }
  }

  private removeStepFromChildren(parent: MissionStep, stepToRemove: MissionStep) {
    if (!parent.children) return;
    parent.children = parent.children.filter((c) => c !== stepToRemove);
    for (const child of parent.children) {
      this.removeStepFromChildren(child, stepToRemove);
    }
  }

  private recomputeMergedView() {
    const missionNodes = this.missionNodes();
    const adHocNodes = this.adHocNodes();

    const allNodes = [...missionNodes, ...adHocNodes];
    const nodeIdSet = new Set(allNodes.map((n) => n.id));
    const validInputId = (id: string) => {
      const base = id.replace(/-input$/, '');
      return nodeIdSet.has(base);
    };
    const validOutputId = (id: string) => {
      const base = id.replace(/-output$/, '');
      return nodeIdSet.has(base) || id === this.startOutputId;
    };

    const missionConns = this.missionConnections();

    const filteredAdHocConns = this.adHocConnections().filter(
      (c) => validOutputId(c.outputId) && validInputId(c.inputId)
    );

    this.nodes.set(allNodes);
    this.connections.set([...missionConns, ...filteredAdHocConns]);
  }

  private convertMissionStepToStep(missionStep: MissionStep): Step {
    const availableSteps = this.stepsState.currentSteps();
    const actualStep = availableSteps?.find((step) => step.name === missionStep.function_name);
    if (actualStep) {
      return actualStep;
    } else {
      return {
        name: missionStep.function_name,
        import: '',
        arguments: missionStep.arguments.map((arg, index) => ({
          name: arg.name || `arg${index}`,
          type: arg.type,
          import: null,
          optional: false,
          default: arg.value
        })),
        file: ''
      };
    }
  }

  private initializeArgs(missionStep: MissionStep): {
    [key: string]: boolean | string | number | null;
  } {
    const args: { [key: string]: boolean | string | number | null } = {};

    const availableSteps = this.stepsState.currentSteps();
    const actualStep = availableSteps?.find((step) => step.name === missionStep.function_name);

    if (actualStep) {
      actualStep.arguments.forEach((stepArg, index) => {
        const missionArg = missionStep.arguments[index];
        let value: string = '';
        if (missionArg && missionArg.value !== null && missionArg.value !== '') {
          value = missionArg.value;
        } else if (stepArg.default !== null && stepArg.default !== '') {
          value = stepArg.default;
        }
        if (stepArg.type === 'bool') {
          args[stepArg.name] = String(value).toLowerCase() === 'true';
        } else if (stepArg.type === 'float') {
          args[stepArg.name] = parseFloat(value) || null;
        } else {
          args[stepArg.name] = value;
        }
      });
    } else {
      missionStep.arguments.forEach((arg, index) => {
        const argName = arg.name || `arg${index}`;
        let value: string = arg.value ?? '';
        if (arg.type === 'bool') {
          args[arg.name] = String(value).toLowerCase() === 'true';
        } else if (arg.type === 'float') {
          args[argName] = parseFloat(value) || null;
        } else {
          args[argName] = value;
        }
      });
    }
    return args;
  }

  private isParallel(step: MissionStep | null | undefined): boolean {
    if (!step) return false;
    const fn = (step.function_name ?? '').toLowerCase();
    const st = (step.step_type ?? '').toLowerCase();
    return fn === 'parallel' || st === 'parallel';
  }

  private baseFromOutputId(outputId: string): string {
    if (outputId === this.startOutputId) return this.startNodeId;
    return outputId.replace(/-output$/, '');
  }

  private baseFromInputId(inputId: string): string {
    return inputId.replace(/-input$/, '');
  }

  private ensureParallelUnder(parent: MissionStep): MissionStep {
    parent.children = parent.children ?? [];
    if (parent.children.length === 0) {
      const par = this.newParallel();
      parent.children.push(par);
      return par;
    }
    if (this.isParallel(parent.children[0])) {
      return parent.children[0];
    }
    const par = this.newParallel();
    par.children = [...parent.children];
    parent.children = [par];
    return par;
  }

  private newParallel(): MissionStep {
    return {
      step_type: 'parallel',
      function_name: 'parallel',
      arguments: [],
      children: []
    };
  }

  private detachFromAllParents(mission: Mission, target: MissionStep, exceptParent?: MissionStep): void {
    const walk = (parent: MissionStep) => {
      if (!parent.children || parent.children.length === 0) return;
      parent.children = parent.children.filter((c) => {
        if (exceptParent && parent === exceptParent) return true;
        // Also dive into parallel containers
        if (c === target) return false;
        walk(c);
        return true;
      });
    };
    mission.steps = mission.steps.filter((top) => top !== target);
    mission.steps.forEach((top) => walk(top));
  }

  private attachChildWithParallel(mission: Mission, parent: MissionStep, child: MissionStep): boolean {
    if (parent === child) return false;
    const alreadyChild = (p: MissionStep): boolean => {
      if (!p.children) return false;
      if (p.children.includes(child)) return true;
      const par = this.isParallel(p.children[0]) ? p.children[0] : null;
      return !!(par && par.children && par.children.includes(child));
    };
    if (alreadyChild(parent)) return false;

    this.detachFromAllParents(mission, child, parent);

    const par = this.ensureParallelUnder(parent);
    par.children = par.children ?? [];
    if (!par.children.includes(child)) {
      par.children.push(child);
      return true;
    }
    return false;
  }

  private missionStepFromAdHoc(node: FlowNode): MissionStep {
    const args = Object.entries(node.args ?? {}).map(([name, v]) => ({
      name,
      value: v === null || v === undefined ? '' : String(v),
      type: node.step?.arguments?.find(a => a.name === name)?.type ?? 'str'
    }));

    return {
      step_type: (node.step?.name ?? '').toLowerCase() === 'parallel' ? 'parallel' : '',
      function_name: node.step?.name || node.text,
      arguments: args,
      children: []
    };
  }

}
