import {Component, signal, viewChild} from '@angular/core';
import {FCanvasComponent, FCreateConnectionEvent, FCreateNodeEvent, FFlowComponent, FFlowModule} from '@foblex/flow';
import {generateGuid} from '@foblex/utils';

@Component({
  selector: 'app-flowchart',
  imports: [
    FFlowComponent,
    FFlowModule
  ],
  templateUrl: './flowchart.html',
  styleUrl: './flowchart.scss'
})
export class Flowchart {
  isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  nodes = signal<{ id: string, text: string, position: any }[]>([]);

  connections = signal<{ outputId: string, inputId: string }[]>([]);

  fCanvas = viewChild(FCanvasComponent);

  onLoaded() {
    this.fCanvas()?.resetScaleAndCenter(false);
  }

  onCreateNode(event: FCreateNodeEvent) {
    const step = event.data as any; // <-- This is the dragged Step
    this.nodes.set([
      ...this.nodes(),
      {
        id: generateGuid(),
        text: step?.name ?? 'New Node',
        position: event.rect,
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
