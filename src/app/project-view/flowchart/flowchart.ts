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
import {StepsStateService} from '../../services/steps-state-service';

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

  constructor(private missionState: MissionStateService, private stepsState: StepsStateService) {
    effect(() => {
      const mission = this.missionState.currentMission();
      if (mission) {
        this.generateFlowFromMission(mission);
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
  }

  public addConnection(event: FCreateConnectionEvent): void {
    if (!event.fInputId) return;

    this.connections.set([
      ...this.connections(),
      { outputId: event.fOutputId, inputId: event.fInputId }
    ]);
  }
}
