import type { Flowchart } from './flowchart';
import { START_OUTPUT_ID } from './constants';

export function cleanupAdHocNode(flow: Flowchart, nodeId: string): void {
  const inputId = `${nodeId}-input`;
  const outputId = `${nodeId}-output`;

  flow.adHocNodes.set(flow.adHocNodes().filter(n => n.id !== nodeId));
  flow.adHocConnections.set(
    flow.adHocConnections().filter(
      c => c.inputId !== inputId && c.outputId !== outputId
    )
  );
}

export function recomputeMergedView(flow: Flowchart): void {
  const missionNodes = flow.missionNodes();
  const adHocNodes = flow.adHocNodes();
  const allNodes = [...missionNodes, ...adHocNodes];
  const ids = new Set(allNodes.map(n => n.id));

  const isValid = (id: string, kind: 'in' | 'out') => {
    if (kind === 'in') {
      return ids.has(id.replace(/-input$/, ''));
    }
    return id === START_OUTPUT_ID || ids.has(id.replace(/-output$/, ''));
  };

  const filteredAdHocConnections = flow
    .adHocConnections()
    .filter(c => isValid(c.outputId, 'out') && isValid(c.inputId, 'in'));

  flow.nodes.set(allNodes);
  flow.connections.set([...flow.missionConnections(), ...filteredAdHocConnections]);
}
