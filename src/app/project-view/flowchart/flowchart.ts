import {Component, effect, signal, viewChild} from '@angular/core';
import { FCanvasComponent, FCreateConnectionEvent, FCreateNodeEvent, FFlowComponent, FFlowModule } from '@foblex/flow';
import { generateGuid } from '@foblex/utils';
import { InputNumberModule } from 'primeng/inputnumber';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { FormsModule } from '@angular/forms';
import {MissionStateService} from '../../services/mission-sate-service';
import {Mission} from '../../entities/Mission';
import {MissionStep} from '../../entities/MissionStep';

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
    FormsModule
  ],
  templateUrl: './flowchart.html',
  styleUrl: './flowchart.scss'
})
export class Flowchart {
  isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  nodes = signal<FlowNode[]>([]);
  connections = signal<{ outputId: string, inputId: string }[]>([]);
  fCanvas = viewChild(FCanvasComponent);

  private startOutputId = 'start-node-output';

  constructor(private missionState: MissionStateService) {
    effect(() => {
      const mission = this.missionState.currentMission();
      if (mission) {
        this.generateFlowFromMission(mission);
        console.log(mission);
      }
    });
  }

  private generateFlowFromMission(mission: Mission) {
    const nodes: FlowNode[] = [];
    const connections: { outputId: string, inputId: string }[] = [];

    const nodeSpacing = 200;
    const nodeWidth = 200; // Width between sibling nodes
    const nodeHeight = 150; // Approximate node height
    const verticalSpacing = 250; // Vertical spacing between levels
    const baseX = 300;
    let currentY = 300;

    let previousExitIds = [this.startOutputId];

    for (const missionStep of mission.steps) {
      const position = { x: baseX, y: currentY };
      const { entryIds, exitIds, maxY, width } = this.processStepWithSiblings(
        [missionStep],
        position,
        0,
        nodes,
        connections,
        nodeWidth,
        nodeHeight,
        verticalSpacing
      );

      // Connect all previous exits to all current entries
      for (const prevExitId of previousExitIds) {
        for (const entryId of entryIds) {
          connections.push({
            outputId: prevExitId,
            inputId: entryId
          });
        }
      }

      previousExitIds = exitIds;

      // Advance currentY for the next top-level node
      currentY = maxY + nodeSpacing;
    }

    // Update signals
    this.nodes.set(nodes);
    this.connections.set(connections);
  }

  private processStepWithSiblings(
    missionSteps: MissionStep[],
    startPosition: { x: number; y: number },
    level: number,
    nodes: FlowNode[],
    connections: { outputId: string, inputId: string }[],
    nodeWidth: number,
    nodeHeight: number,
    verticalSpacing: number
  ): { entryIds: string[]; exitIds: string[]; maxY: number; width: number } {
    const entryIds: string[] = [];
    const exitIds: string[] = [];
    let maxY = startPosition.y + nodeHeight;

    // Calculate total width needed for all siblings
    const totalWidth = (missionSteps.length - 1) * nodeWidth;
    const startX = startPosition.x - totalWidth / 2;

    // Process each sibling
    for (let i = 0; i < missionSteps.length; i++) {
      const missionStep = missionSteps[i];
      const siblingX = startX + (i * nodeWidth);
      const siblingPosition = { x: siblingX, y: startPosition.y };

      const nodeId = generateGuid();
      const inputId = nodeId + '-input';
      const outputId = nodeId + '-output';

      const node: FlowNode = {
        id: nodeId,
        text: missionStep.function_name,
        position: siblingPosition,
        step: this.convertMissionStepToStep(missionStep),
        args: this.initializeArgs(missionStep)
      };
      nodes.push(node);

      entryIds.push(inputId);
      let currentExitIds = [outputId];
      let currentMaxY = startPosition.y + nodeHeight;

      // Process children if they exist
      if (missionStep.children && missionStep.children.length > 0) {
        const childY = startPosition.y + verticalSpacing;
        const childPosition = { x: siblingX, y: childY };

        const childResult = this.processStepWithSiblings(
          missionStep.children,
          childPosition,
          level + 1,
          nodes,
          connections,
          nodeWidth,
          nodeHeight,
          verticalSpacing
        );

        // Connect this node's output to all child entries
        for (const childEntryId of childResult.entryIds) {
          connections.push({
            outputId: outputId,
            inputId: childEntryId
          });
        }

        currentExitIds = childResult.exitIds;
        currentMaxY = childResult.maxY;
      }

      // Update exit IDs and maxY
      exitIds.push(...currentExitIds);
      maxY = Math.max(maxY, currentMaxY);
    }

    return {
      entryIds,
      exitIds,
      maxY,
      width: totalWidth + nodeWidth // Include the width of the rightmost node
    };
  }

  private convertMissionStepToStep(missionStep: MissionStep): Step {
    return {
      name: missionStep.function_name,
      import: '',
      arguments: missionStep.arguments.map(arg => ({
        name: arg.name,
        type: arg.type,
        import: null,
        optional: false,
        default: arg.value // Fixed: Use arg.value as the default, not undefined
      })),
      file: ''
    };
  }

  private initializeArgs(missionStep: MissionStep): { [key: string]: boolean | string | number | null } {
    const args: { [key: string]: boolean | string | number | null } = {};

    missionStep.arguments.forEach(arg => {
      if (arg.value !== null && arg.value !== '') {
        if (arg.type === 'bool') {
          args[arg.name] = arg.value.toLowerCase() === 'true';
        } else if (arg.type === 'float') {
          args[arg.name] = parseFloat(arg.value) || null;
        } else {
          args[arg.name] = arg.value;
        }
      } else {
        args[arg.name] = arg.type === 'bool' ? false : arg.type === 'float' ? null : '';
      }
    });

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
  }

  public addConnection(event: FCreateConnectionEvent): void {
    if (!event.fInputId) return;

    this.connections.set([
      ...this.connections(),
      { outputId: event.fOutputId, inputId: event.fInputId }
    ]);
  }
}
