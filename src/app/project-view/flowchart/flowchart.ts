import { Component, signal, viewChild } from '@angular/core';
import { FCanvasComponent, FCreateConnectionEvent, FCreateNodeEvent, FFlowComponent, FFlowModule } from '@foblex/flow';
import { generateGuid } from '@foblex/utils';
import { InputNumberModule } from 'primeng/inputnumber';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { FormsModule } from '@angular/forms';

interface Step {
  name: string;
  import: string;
  arguments: {
    name: string;
    type: string;
    import: string | null;
    optional: boolean;
    default: string | null;
  }[];
  file: string;
}

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
