import type { Flowchart } from './flowchart';
import { FCreateNodeEvent } from '@foblex/flow';
import { generateGuid } from '@foblex/utils';
import { Step, toVal, isType } from './models';
import { normalize, findParentAndIndex } from './mission-utils';
import { cleanupAdHocNode, recomputeMergedView } from './view-merger';
import { MissionStep } from '../../entities/MissionStep';
import { Mission } from '../../entities/Mission';
import { rebuildFromMission } from './mission-handlers';
import { removeNodeFromGroups } from './group-handlers';
import { prepareStepForFlowEditor } from './step-utils';

export function handleCreateNode(flow: Flowchart, event: FCreateNodeEvent): void {
  const step = prepareStepForFlowEditor(event.data as Step);
  const args: Record<string, boolean | string | number | null> = {};
  step?.arguments?.forEach(arg => {
    args[arg.name] = toVal(arg.type, arg.default ?? '');
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
  const selected = flow.selectedNodeIds();
  const fallbackId = flow.contextMenu.selectedNodeId;
  const ids = selected.size ? Array.from(selected) : (fallbackId ? [fallbackId] : []);
  const targetIds = ids.filter(id => id && id !== 'start-node');
  if (!targetIds.length) {
    return;
  }

  const mission = flow.missionState.currentMission();
  let changed = false;
  let missionChanged = false;
  const toRemoveFromGroups: string[] = [];

  if (mission) {
    for (const id of targetIds) {
      const step = flow.lookups.nodeIdToStep.get(id);
      if (!step) continue;
      const removed = removeMissionStep(mission, step);
      if (removed) {
        changed = true;
        missionChanged = true;
        toRemoveFromGroups.push(id);
      }
    }
  }

  const beforeAdHoc = flow.adHocNodes().length;
  targetIds.forEach(id => {
    cleanupAdHocNode(flow, id);
  });
  if (flow.adHocNodes().length !== beforeAdHoc) {
    changed = true;
    toRemoveFromGroups.push(...targetIds);
  }

  if (!changed) {
    return;
  }

  if (missionChanged) {
    normalize(mission!, 'parallel');
    normalize(mission!, 'seq');
    rebuildFromMission(flow, mission!);
  } else {
    recomputeMergedView(flow);
  }

  toRemoveFromGroups.forEach(id => removeNodeFromGroups(flow, id, false));
  flow.contextMenu.selectedNodeId = '';
  flow.clearNodeSelection();
  flow.layoutFlags.needsAdjust = true;
  flow.historyManager.recordHistory('delete-node');
}
function removeMissionStep(mission: Mission, step: MissionStep): boolean {
  const location = findParentAndIndex(mission, step);
  if (!location) {
    return false;
  }

  const { container, index } = location;
  if (!container) {
    return false;
  }

  const shouldPromoteChild =
    !isType(step, 'parallel') &&
    !isType(step, 'seq') &&
    !isType(step, 'breakpoint') &&
    (step.children?.length === 1);

  const replacement = shouldPromoteChild ? step.children![0] : null;
  if (replacement) {
    container.splice(index, 1, replacement);
  } else {
    container.splice(index, 1);
  }

  return true;
}
