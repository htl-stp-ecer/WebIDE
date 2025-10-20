import type { Flowchart } from './flowchart';
import { FCreateConnectionEvent, FNodeIntersectedWithConnections } from '@foblex/flow';
import { generateGuid } from '@foblex/utils';
import { baseId } from './models';
import {
  attachChildSequentially,
  attachChildWithParallel,
  attachToStartWithParallel,
  detachEverywhere,
  insertBetween,
  shouldAppendSequentially,
} from './mission-utils';
import { missionStepFromAdHoc } from './step-utils';
import { cleanupAdHocNode, recomputeMergedView } from './view-merger';
import { START_NODE_ID } from './constants';
import { MissionStep } from '../../entities/MissionStep';
import { rebuildFromMission } from './mission-handlers';

export function handleAddConnection(flow: Flowchart, event: FCreateConnectionEvent): void {
  if (!event.fInputId) return;
  const mission = flow.missionState.currentMission();
  if (!mission) return;

  const srcId = baseId(event.fOutputId, 'output');
  const dstId = baseId(event.fInputId, 'input');
  if (srcId === dstId) return;

  const srcStep = flow.lookups.nodeIdToStep.get(srcId);
  const dstStep = flow.lookups.nodeIdToStep.get(dstId);

  const promote = (adhocId: string, parent?: MissionStep) => {
    const node = flow.adHocNodes().find(n => n.id === adhocId);
    if (!node) return false;

    const missionStep = missionStepFromAdHoc(node);
    flow.lookups.stepToNodeId.set(missionStep, node.id);

    if (parent) {
      let attached = false;
      if (shouldAppendSequentially(mission, parent)) {
        attached = attachChildSequentially(mission, parent, missionStep);
      }
      if (!attached) {
        attachChildWithParallel(mission, parent, missionStep);
      }
    } else {
      (mission.steps ??= []).push(missionStep);
    }

    cleanupAdHocNode(flow, node.id);
    rebuildFromMission(flow, mission);
    flow.layoutFlags.needsAdjust = true;
    flow.historyManager.recordHistory('promote-node');
    return true;
  };

  if (srcId === START_NODE_ID) {
    if (
      (dstStep && attachToStartWithParallel(mission, dstStep)) ||
      (!dstStep && promote(dstId))
    ) {
      rebuildFromMission(flow, mission);
      flow.layoutFlags.needsAdjust = true;
      flow.historyManager.recordHistory('attach-to-start');
      return;
    }
  }

  if (srcStep && !dstStep && promote(dstId, srcStep)) return;

  if (srcStep && dstStep && attachChildWithParallel(mission, srcStep, dstStep)) {
    rebuildFromMission(flow, mission);
    flow.layoutFlags.needsAdjust = true;
    flow.historyManager.recordHistory('connect-existing-steps');
    return;
  }

  flow.adHocConnections.set([
    ...flow.adHocConnections(),
    { id: generateGuid(), outputId: event.fOutputId, inputId: event.fInputId },
  ]);
  recomputeMergedView(flow);
  flow.historyManager.recordHistory('create-adhoc-connection');
}

export function handleNodeIntersected(flow: Flowchart, event: FNodeIntersectedWithConnections): void {
  const nodeId = event.fNodeId;
  const hitId = event.fConnectionIds?.[0];
  if (!hitId || nodeId === START_NODE_ID) return;

  const adHoc = flow.adHocConnections();
  const index = adHoc.findIndex(c => c.id === hitId);
  if (index !== -1) {
    const hit = adHoc[index];
    const updated = adHoc.slice();
    updated[index] = { ...hit, inputId: `${nodeId}-input` };
    updated.push({ id: generateGuid(), outputId: `${nodeId}-output`, inputId: hit.inputId });
    flow.adHocConnections.set(updated);
    recomputeMergedView(flow);
    flow.historyManager.recordHistory('split-adhoc-connection');
    return;
  }

  const mission = flow.missionState.currentMission();
  if (!mission) return;

  const connection = flow.connections().find(c => c.id === hitId);
  if (!connection) return;

  const srcBase = baseId(connection.outputId, 'output');
  const dstBase = baseId(connection.inputId, 'input');

  const parentStep = srcBase === START_NODE_ID ? null : flow.lookups.nodeIdToStep.get(srcBase) ?? null;
  const childStep = flow.lookups.nodeIdToStep.get(dstBase);
  if (!childStep) return;

  let midStep = flow.lookups.nodeIdToStep.get(nodeId) ?? null;
  if (!midStep) {
    const adhocNode = flow.adHocNodes().find(n => n.id === nodeId);
    if (!adhocNode) return;
    midStep = missionStepFromAdHoc(adhocNode);
    flow.lookups.stepToNodeId.set(midStep, adhocNode.id);
    cleanupAdHocNode(flow, adhocNode.id);
  }

  if (midStep === parentStep || midStep === childStep) {
    return;
  }

  detachEverywhere(mission, midStep);
  if (insertBetween(mission, parentStep, childStep, midStep)) {
    rebuildFromMission(flow, mission);
    flow.layoutFlags.needsAdjust = true;
    flow.historyManager.recordHistory('split-mission-connection');
  }
}
