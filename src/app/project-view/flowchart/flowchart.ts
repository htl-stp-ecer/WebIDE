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
    const nodeHeight = 150; // Approximate node height
    const indent = 200; // Indentation for children
    const baseX = 300;
    let currentY = 300;

    let previousExit = this.startOutputId;

    for (const missionStep of mission.steps) {
      const position = { x: baseX, y: currentY };
      const { entryId, exitId, maxY } = this.processStep(
        missionStep,
        position,
        0,
        nodes,
        connections,
        nodeSpacing,
        nodeHeight,
        indent
      );

      // Connect previous exit to this entry
      connections.push({
        outputId: previousExit,
        inputId: entryId
      });

      previousExit = exitId;

      // Advance currentY for the next top-level node
      currentY = maxY + nodeSpacing;
    }

    // Update signals
    this.nodes.set(nodes);
    this.connections.set(connections);
  }

  private processStep(
    missionStep: MissionStep,
    position: { x: number; y: number },
    level: number,
    nodes: FlowNode[],
    connections: { outputId: string, inputId: string }[],
    nodeSpacing: number,
    nodeHeight: number,
    indent: number
  ): { entryId: string; exitId: string; maxY: number } {
    const nodeId = generateGuid();
    // Fixed: Use consistent naming pattern
    const inputId = nodeId + '-input';
    const outputId = nodeId + '-output';
    const node: FlowNode = {
      id: nodeId,
      text: missionStep.function_name,
      position,
      step: this.convertMissionStepToStep(missionStep),
      args: this.initializeArgs(missionStep)
    };
    nodes.push(node);

    let entryId = inputId;
    let exitId = outputId;
    let maxY = position.y + nodeHeight;

    if (missionStep.children && missionStep.children.length > 0) {
      let currentExit = outputId;
      let childY = maxY + nodeSpacing;
      const childX = position.x + indent * (level + 1);

      for (const child of missionStep.children) {
        const childPosition = { x: childX, y: childY };
        const childRes = this.processStep(
          child,
          childPosition,
          level + 1,
          nodes,
          connections,
          nodeSpacing,
          nodeHeight,
          indent
        );

        // Connect current exit to child entry
        connections.push({
          outputId: currentExit,
          inputId: childRes.entryId
        });

        // Update current exit to child's exit
        currentExit = childRes.exitId;

        // Update maxY
        maxY = childRes.maxY;

        // Advance childY for next child
        childY = maxY + nodeSpacing;
      }

      exitId = currentExit;
    }

    return { entryId, exitId, maxY };
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
        default: arg.value
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
      if (arg.default !== null) {
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
