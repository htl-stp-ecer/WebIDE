import { effect, untracked } from '@angular/core';
import type { Flowchart } from './flowchart';
import { rebuildFromMission } from './mission-handlers';

export function setupFlowchartEffects(flow: Flowchart): void {
  effect(() => {
    const mission = flow.missionState.currentMission();
    untracked(() => {
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

      flow.updatePlannedPathForMission(mission);
    });
  });

  effect(() => {
    const steps = flow.stepsState.currentSteps();
    if (steps === null) {
      return;
    }
    if (!flow.historyManager.shouldProcessMissionEffect()) {
      return;
    }
    const mission = untracked(() => flow.missionState.currentMission());
    if (!mission) {
      return;
    }
    untracked(() => {
      rebuildFromMission(flow, mission);
      flow.layoutFlags.needsAdjust = true;
    });
  });

  effect(() => {
    flow.history.changes();
    if (!flow.historyManager.isTraversingHistory()) {
      return;
    }
    flow.historyManager.applySnapshotFromHistory();
  });
}
