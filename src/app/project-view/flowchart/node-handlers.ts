import type { Flowchart } from './flowchart';
import { FCreateNodeEvent } from '@foblex/flow';
import { generateGuid } from '@foblex/utils';
import { Step, toVal } from './models';
import { normalize } from './mission-utils';
import { cleanupAdHocNode, recomputeMergedView } from './view-merger';
import { MissionStep } from '../../entities/MissionStep';
import { Mission } from '../../entities/Mission';
import { rebuildFromMission } from './mission-handlers';

export function handleCreateNode(flow: Flowchart, event: FCreateNodeEvent): void {
  const step = event.data as Step;
  const args: Record<string, boolean | string | number | null> = {};
  step?.arguments?.forEach(arg => {
    args[arg.name] = toVal(arg.type, String((arg.default ?? '') !== '' ? arg.default : ''));
  });

  flow.adHocNodes.set([
    ...flow.adHocNodes(),
    {
      id: generateGuid(),
      text: step?.name ?? flow.translate.instant('FLOWCHART.NEW_NODE'),
      position: event.rect,
      step,
      args,
    },
  ]);
  recomputeMergedView(flow);
  flow.layoutFlags.needsAdjust = true;
  flow.historyManager.recordHistory('create-node');
}

export function deleteNode(flow: Flowchart): void {
  const nodeId = flow.contextMenu.selectedNodeId;
  if (!nodeId) {
    return;
  }

  const mission = flow.missionState.currentMission();
  const step = flow.lookups.nodeIdToStep.get(nodeId);
  let changed = false;

  if (step && mission) {
    changed = removeMissionStep(mission, step);
    if (changed) {
      normalize(mission, 'parallel');
      normalize(mission, 'seq');
      rebuildFromMission(flow, mission);
    }
  } else {
    const before = flow.adHocNodes().length;
    cleanupAdHocNode(flow, nodeId);
    if (flow.adHocNodes().length !== before) {
      recomputeMergedView(flow);
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  flow.contextMenu.selectedNodeId = '';
  flow.layoutFlags.needsAdjust = true;
  flow.historyManager.recordHistory('delete-node');
}
function removeMissionStep(mission: Mission, step: MissionStep): boolean {
  const visit = (steps?: MissionStep[]): boolean => {
    if (!steps) {
      return false;
    }
    for (let i = 0; i < steps.length;) {
      const current = steps[i];
      if (current === step) {
        steps.splice(i, 1);
        return true;
      }
      if (visit(current.children)) {
        return true;
      }
      i++;
    }
    return false;
  };

  return visit(mission.steps);
}
