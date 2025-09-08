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
import { generateGuid } from '@foblex/utils';
import { InputNumberModule } from 'primeng/inputnumber';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { FormsModule } from '@angular/forms';
import { MissionStateService } from '../../services/mission-sate-service';
import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { StepsStateService } from '../../services/steps-state-service';
import { ContextMenuModule } from 'primeng/contextmenu';
import { ContextMenu } from 'primeng/contextmenu';
import { MenuItem } from 'primeng/api';
import { Tooltip } from 'primeng/tooltip';

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
    FormsModule,
    ContextMenuModule,
    Tooltip
  ],
  templateUrl: './flowchart.html',
  styleUrl: './flowchart.scss'
})
export class Flowchart implements AfterViewChecked {
  isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  /**
   * Public, merged, render-ready signals
   */
  nodes = signal<FlowNode[]>([]);
  connections = signal<{ outputId: string; inputId: string }[]>([]);

  /**
   * Separate stores so mission rebuilds never touch ad-hoc items
   */
  private missionNodes = signal<FlowNode[]>([]);
  private missionConnections = signal<{ outputId: string; inputId: string }[]>([]);
  private adHocNodes = signal<FlowNode[]>([]);
  private adHocConnections = signal<{ outputId: string; inputId: string }[]>([]);

  fCanvas = viewChild(FCanvasComponent);

  private readonly startNodeId = 'start-node';
  private readonly startOutputId = 'start-node-output';

  /**
   * Keep a stable mapping between MissionStep objects and nodeIds
   * so regenerations won't break connections pointing to mission nodes.
   */
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
      if (mission) {
        this.generateStructure(mission);
        this.needsAdjust = true;
      }
    });
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

  /**
   * ===== Layout helpers =====
   */
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

    // Copy so we can mutate
    const newNodes = this.nodes().map((n) => ({ ...n, position: { ...n.position } }));

    const updatePosition = (id: string, pos: { x: number; y: number }) => {
      const node = newNodes.find((n) => n.id === id);
      if (node) node.position = pos;
    };

    const mission = this.missionState.currentMission();
    if (mission) {
      for (const missionStep of mission.steps) {
        const startPos = { x: 300, y: currentY };
        const res = this.assignPositions([missionStep], startPos, 200, 100, updatePosition, nodeHeights);
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

    const siblingHeights = missionSteps.map((step) => {
      const nodeId = this.stepToNodeId.get(step);
      return nodeId ? nodeHeights.get(nodeId) ?? 80 : 80;
    });

    const maxSiblingHeight = Math.max(...siblingHeights);
    const totalWidth = (missionSteps.length - 1) * nodeWidth;
    const startX = startPosition.x - totalWidth / 2;

    let maxY = startPosition.y;

    for (let i = 0; i < missionSteps.length; i++) {
      const missionStep = missionSteps[i];
      const nodeId = this.stepToNodeId.get(missionStep);
      if (!nodeId) continue;

      const siblingX = startX + i * nodeWidth;
      const pos = { x: siblingX, y: startPosition.y };
      updatePosition(nodeId, pos);

      const nodeHeight = siblingHeights[i];
      let currentMaxY = startPosition.y + nodeHeight;

      if (missionStep.children && missionStep.children.length > 0) {
        const childPosition = { x: siblingX, y: startPosition.y + maxSiblingHeight + verticalSpacing };
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

  /**
   * ===== Mission build (id-stable & ad-hoc safe) =====
   */
  private generateStructure(mission: Mission) {
    // Build mission nodes and connections WITHOUT touching ad-hoc
    const newMissionNodes: FlowNode[] = [];
    const newMissionConnections: { outputId: string; inputId: string }[] = [];

    const oldStepToNodeId = new Map(this.stepToNodeId);

    // We'll repopulate these maps with the steps that still exist
    this.stepToNodeId = new Map();
    this.nodeIdToStep.clear();

    // Connect Start node to first top-level step chain(s)
    let previousExitIds: string[] = [this.startOutputId];

    for (const topStep of mission.steps) {
      const result = this.createNodesAndConnectionsStable([topStep], previousExitIds, newMissionNodes, newMissionConnections, oldStepToNodeId);
      previousExitIds = result.exitIds;
    }

    // Store mission parts
    this.missionNodes.set(newMissionNodes);
    this.missionConnections.set(newMissionConnections);

    // Merge with ad-hoc (and auto-filter ad-hoc connections that reference missing nodes)
    this.recomputeMergedView();
  }

  /**
   * Same as old createNodesAndConnections, but:
   *  - reuses nodeIds for existing MissionStep objects (stability)
   *  - fills step/node maps accordingly
   */
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
      // Reuse ID if exists; otherwise create one
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

      // Connect with parents
      for (const parentExitId of parentExitIds) {
        connsOut.push({ outputId: parentExitId, inputId });
      }

      entryIds.push(inputId);

      // Recurse into children; by default exitIds = this node's output unless children override
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

  /**
   * ===== Public creation & connection (AD-HOC) =====
   */
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

    // Refresh merged view
    this.recomputeMergedView();

    // Adjust layout after adding
    this.needsAdjust = true;
  }

  public addConnection(event: FCreateConnectionEvent): void {
    if (!event.fInputId) return;
    // User-created connections are considered ad-hoc so they survive mission rebuilds.
    this.adHocConnections.set([
      ...this.adHocConnections(),
      { outputId: event.fOutputId, inputId: event.fInputId }
    ]);
    this.recomputeMergedView();
  }

  /**
   * ===== Context menu / deletion =====
   */
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
      // Delete a mission step
      this.removeStepFromMission(stepToRemove);
      // Regenerate mission structure (ids kept stable for remaining steps)
      const mission = this.missionState.currentMission();
      if (mission) this.generateStructure(mission);
    } else {
      // Delete an ad-hoc node
      this.adHocNodes.set(this.adHocNodes().filter((n) => n.id !== nodeId));

      const inputId = `${nodeId}-input`;
      const outputId = `${nodeId}-output`;

      // Only remove from ad-hoc connections; leave mission connections intact
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

    // Remove from top-level steps
    mission.steps = mission.steps.filter((s) => s !== stepToRemove);

    // Recursively remove from children
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

  /**
   * ===== Merge mission + ad-hoc for rendering =====
   *  - Filters ad-hoc connections that reference missing endpoints
   */
  private recomputeMergedView() {
    const missionNodes = this.missionNodes();
    const adHocNodes = this.adHocNodes();

    const allNodes = [...missionNodes, ...adHocNodes];
    const nodeIdSet = new Set(allNodes.map((n) => n.id));
    const validInputId = (id: string) => {
      const base = id.replace(/-input$/, '');
      return nodeIdSet.has(base) || id === this.startOutputId; // start-output handled separately
    };
    const validOutputId = (id: string) => {
      const base = id.replace(/-output$/, '');
      return nodeIdSet.has(base) || id === this.startOutputId;
    };

    // Mission connections are already valid by construction
    const missionConns = this.missionConnections();

    // Keep only ad-hoc connections that still point to existing nodes
    const filteredAdHocConns = this.adHocConnections().filter(
      (c) => validOutputId(c.outputId) && validInputId(c.inputId)
    );

    this.nodes.set(allNodes);
    this.connections.set([...missionConns, ...filteredAdHocConns]);
  }

  /**
   * ===== Conversion & args init =====
   */
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
        let value: string = arg.value;
        if (value === null || value === '') {
          value = '';
        }
        if (arg.type === 'bool') {
          args[argName] = value.toLowerCase() === 'true';
        } else if (arg.type === 'float') {
          args[argName] = parseFloat(value) || null;
        } else {
          args[argName] = value;
        }
      });
    }
    return args;
  }
}
