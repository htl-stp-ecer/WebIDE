import { effect } from '@angular/core';
import type { Flowchart } from './flowchart';
import { rebuildFromMission } from './mission-handlers';

export function setupFlowchartEffects(flow: Flowchart): void {
  effect(() => {
    const mission = flow.missionState.currentMission();
    if (!flow.historyManager.shouldProcessMissionEffect()) {
      return;
    }

    const missionChanged = flow.historyManager.prepareForMission(mission);
    if (missionChanged) {
      flow.contextMenu.commentDrafts.clear();
    }

    if (mission) {
      rebuildFromMission(flow, mission);
      flow.layoutFlags.needsAdjust = true;
    } else {
      flow.historyManager.clearFlowState();
      flow.lookups.resetForMission();
      flow.runManager.updatePathLookups(flow.lookups.pathToNodeId, flow.lookups.pathToConnectionIds);
    }

    if (missionChanged) {
      flow.historyManager.resetHistoryWithCurrentState();
    }
  });

  effect(() => {
    flow.history.changes();
    if (!flow.historyManager.isTraversingHistory()) {
      return;
    }
    flow.historyManager.applySnapshotFromHistory();
  });
}
