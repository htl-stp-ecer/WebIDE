import type { Flowchart } from './flowchart';
import { FlowchartHistoryManager } from './flowchart-history-manager';
import { FlowchartRunManager } from './flowchart-run-manager';
import { recomputeMergedView } from './view-merger';

export function createHistoryManager(flow: Flowchart): FlowchartHistoryManager {
  return new FlowchartHistoryManager({
    missionState: flow.missionState,
    history: flow.history,
    missionNodes: flow.missionNodes,
    missionConnections: flow.missionConnections,
    adHocNodes: flow.adHocNodes,
    adHocConnections: flow.adHocConnections,
    comments: flow.comments,
    nodes: flow.nodes,
    connections: flow.connections,
    recomputeMergedView: () => recomputeMergedView(flow),
    markNeedsAdjust: () => {
      flow.layoutFlags.needsAdjust = true;
    },
    markViewportResetPending: () => {
      flow.layoutFlags.pendingViewportReset = true;
    },
  });
}

export function createRunManager(flow: Flowchart): FlowchartRunManager {
  return new FlowchartRunManager({
    http: flow.http,
    isRunActive: flow.isRunActive,
    getProjectUUID: () => flow.projectUUID,
    getMissionKey: () => flow.historyManager.getMissionKey(),
  });
}
