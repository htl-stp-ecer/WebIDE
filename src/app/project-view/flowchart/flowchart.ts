import {Component, signal, viewChild} from '@angular/core';
import {FCanvasComponent, FCreateNodeEvent, FFlowComponent, FFlowModule} from '@foblex/flow';
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
  nodes = signal<{ id: string, text: string, position: any }[]>([]);

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
}
