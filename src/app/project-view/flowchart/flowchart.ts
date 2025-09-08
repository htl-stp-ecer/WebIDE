import {AfterViewChecked, Component, effect, QueryList, signal, viewChild, ViewChildren, ElementRef, ViewChild} from '@angular/core';
import { FCanvasComponent, FCreateConnectionEvent, FCreateNodeEvent, FFlowComponent, FFlowModule } from '@foblex/flow';
import { generateGuid } from '@foblex/utils';
import { InputNumberModule } from 'primeng/inputnumber';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { FormsModule } from '@angular/forms';
import {MissionStateService} from '../../services/mission-sate-service';
import {Mission} from '../../entities/Mission';
import {MissionStep} from '../../entities/MissionStep';
import {StepsStateService} from '../../services/steps-state-service';
import { ContextMenuModule } from 'primeng/contextmenu';
import { ContextMenu } from 'primeng/contextmenu';
import { MenuItem } from 'primeng/api';
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
    ContextMenuModule
  ],
  templateUrl: './flowchart.html',
  styleUrl: './flowchart.scss'
})
export class Flowchart implements AfterViewChecked {
  isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  nodes = signal<FlowNode[]>([]);
  connections = signal<{ outputId: string, inputId: string }[]>([]);
  fCanvas = viewChild(FCanvasComponent);
  private startNodeId = 'start-node';
  private startOutputId = 'start-node-output';
  private stepToNodeId: Map<MissionStep, string> = new Map();
  private nodeIdToStep: Map<string, MissionStep> = new Map();
  private needsAdjust: boolean = false;
  @ViewChildren('nodeElement') nodeElements!: QueryList<ElementRef<HTMLDivElement>>;
  @ViewChild('cm') cm!: ContextMenu;
  items: MenuItem[] = [
    { label: 'Delete', icon: 'pi pi-trash', command: () => this.deleteNode() }
  ];
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
  private getNodeHeights(): Map<string, number> {
    const heights = new Map<string, number>();
    this.nodeElements.forEach(el => {
      const id = el.nativeElement.dataset["nodeId"];
      if (id) {
        heights.set(id, el.nativeElement.offsetHeight);
      }
    });
    return heights;
  }
  private adjustPositions(): void {
    const nodeHeights = this.getNodeHeights();
    const startHeight = nodeHeights.get(this.startNodeId) ?? 80;
    let currentY = startHeight + 100;
    const newNodes = this.nodes().map(n => ({ ...n, position: { ...n.position } }));
    const updatePosition = (id: string, pos: { x: number; y: number }) => {
      const node = newNodes.find(n => n.id === id)!;
      node.position = pos;
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
    if (missionSteps.length === 0) {
      return { maxY: startPosition.y, width: 0 };
    }
    const siblingHeights = missionSteps.map(step => {
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
      const siblingX = startX + (i * nodeWidth);
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
  private generateStructure(mission: Mission) {
    this.stepToNodeId.clear();
    this.nodeIdToStep.clear();
    const nodes: FlowNode[] = [];
    const connections: { outputId: string; inputId: string }[] = [];
    let previousExitIds: string[] = [this.startOutputId];
    for (const missionStep of mission.steps) {
      const result = this.createNodesAndConnections(
        [missionStep],
        previousExitIds,
        nodes,
        connections
      );
      previousExitIds = result.exitIds;
    }
    this.nodes.set(nodes);
    this.connections.set(connections);
  }
  private createNodesAndConnections(
    missionSteps: MissionStep[],
    parentExitIds: string[],
    nodes: FlowNode[],
    connections: { outputId: string; inputId: string }[]
  ): { entryIds: string[]; exitIds: string[] } {
    const entryIds: string[] = [];
    const exitIds: string[] = [];
    for (const missionStep of missionSteps) {
      const nodeId = generateGuid();
      this.stepToNodeId.set(missionStep, nodeId);
      this.nodeIdToStep.set(nodeId, missionStep);
      const inputId = nodeId + '-input';
      const outputId = nodeId + '-output';
      const node: FlowNode = {
        id: nodeId,
        text: missionStep.function_name,
        position: { x: 0, y: 0 },
        step: this.convertMissionStepToStep(missionStep),
        args: this.initializeArgs(missionStep)
      };
      nodes.push(node);
      for (const parentExitId of parentExitIds) {
        connections.push({ outputId: parentExitId, inputId });
      }
      entryIds.push(inputId);
      let currentExitIds: string[] = [outputId];
      if (missionStep.children && missionStep.children.length > 0) {
        const childResult = this.createNodesAndConnections(
          missionStep.children,
          [outputId],
          nodes,
          connections
        );
        currentExitIds = childResult.exitIds;
      }
      exitIds.push(...currentExitIds);
    }
    return { entryIds, exitIds };
  }
  private convertMissionStepToStep(missionStep: MissionStep): Step {
    const availableSteps = this.stepsState.currentSteps();
    const actualStep = availableSteps?.find(step => step.name === missionStep.function_name);
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
  private initializeArgs(missionStep: MissionStep): { [key: string]: boolean | string | number | null } {
    const args: { [key: string]: boolean | string | number | null } = {};
    // Get the actual step definition to use its argument structure
    const availableSteps = this.stepsState.currentSteps();
    const actualStep = availableSteps?.find(step => step.name === missionStep.function_name);
    if (actualStep) {
      // Initialize args based on the actual step definition, mapping by index
      actualStep.arguments.forEach((stepArg, index) => {
        const missionArg = missionStep.arguments[index];
        let value: string = '';
        if (missionArg && missionArg.value !== null && missionArg.value !== '') {
          // Use the value from missionStep if available
          value = missionArg.value;
        } else if (stepArg.default !== null && stepArg.default !== '') {
          // Use the default from the step definition
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
      // Fallback to original logic if step not found, using index if name is null
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
  onLoaded() {
    this.fCanvas()?.resetScaleAndCenter(false);
  }
  onCreateNode(event: FCreateNodeEvent) {
    const step = event.data as Step;
    const args: { [key: string]: boolean | string | number | null } = {};
    step?.arguments?.forEach(arg => {
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
    this.nodes.set([
      ...this.nodes(),
      {
        id: generateGuid(),
        text: step?.name ?? 'New Node',
        position: event.rect,
        step: step,
        args: args
      }
    ]);
    this.needsAdjust = true;
  }
  public addConnection(event: FCreateConnectionEvent): void {
    if (!event.fInputId) return;
    this.connections.set([
      ...this.connections(),
      { outputId: event.fOutputId, inputId: event.fInputId }
    ]);
  }
  onRightClick(event: MouseEvent, nodeId: string) {
    event.preventDefault();
    this.selectedNodeId = nodeId;
    this.cm.show(event);
  }
  deleteNode() {
    const nodeId = this.selectedNodeId;
    const stepToRemove = this.nodeIdToStep.get(nodeId);
    if (stepToRemove) {
      this.removeStepFromMission(stepToRemove);
      this.stepToNodeId.delete(stepToRemove);
      this.nodeIdToStep.delete(nodeId);
    } else {
      // For nodes not in mission (e.g., newly created)
      this.nodes.set(this.nodes().filter(n => n.id !== nodeId));
      const inputId = `${nodeId}-input`;
      const outputId = `${nodeId}-output`;
      this.connections.set(this.connections().filter(c => c.outputId !== outputId && c.inputId !== inputId));
    }
    this.needsAdjust = true;
  }
  private removeStepFromMission(stepToRemove: MissionStep) {
    const mission = this.missionState.currentMission();
    if (!mission) return;
    // Remove from top-level steps
    mission.steps = mission.steps.filter(s => s !== stepToRemove);
    // Recursively remove from children
    for (const step of mission.steps) {
      this.removeStepFromChildren(step, stepToRemove);
    }
    // Manually regenerate structure since we mutated the mission
    this.generateStructure(mission);
  }
  private removeStepFromChildren(parent: MissionStep, stepToRemove: MissionStep) {
    if (!parent.children) return;
    parent.children = parent.children.filter(c => c !== stepToRemove);
    for (const child of parent.children) {
      this.removeStepFromChildren(child, stepToRemove);
    }
  }
}
