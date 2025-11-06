import type { Flowchart } from './flowchart';
import { FCreateConnectionEvent, FNodeIntersectedWithConnections } from '@foblex/flow';
import { generateGuid } from '@foblex/utils';
import { baseId, isBreakpoint, mk, isType } from './models';
import {
  attachChildSequentially,
  attachChildWithParallel,
  attachToStartWithParallel,
  detachEverywhere,
  insertBetween,
  findParentAndIndex,
  shouldAppendSequentially,
  containsStep,
} from './mission-utils';
import { missionStepFromAdHoc } from './step-utils';
import { cleanupAdHocNode, recomputeMergedView } from './view-merger';
import { LAYOUT_SPACING, START_NODE_ID } from './constants';
import { MissionStep } from '../../entities/MissionStep';
import { rebuildFromMission } from './mission-handlers';
import { Mission } from '../../entities/Mission';

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

  const parentNodeId =
    connection.sourceNodeId ??
    (connection.outputId ? baseId(connection.outputId, 'output') : null);
  const childNodeId =
    connection.targetNodeId ??
    (connection.inputId ? baseId(connection.inputId, 'input') : null);

  const parentStep = parentNodeId === START_NODE_ID || !parentNodeId
    ? null
    : flow.lookups.nodeIdToStep.get(parentNodeId) ?? null;
  const childStep = childNodeId ? flow.lookups.nodeIdToStep.get(childNodeId) ?? null : null;
  if (!childStep) return;

  const isInsideParallelBranch = (step: MissionStep | null): boolean => {
    let current = step;
    while (current) {
      const loc = findParentAndIndex(mission, current);
      const directParent = loc?.parent ?? null;
      if (!directParent) return false;
      if (isType(directParent, 'parallel')) return true;
      current = directParent;
    }
    return false;
  };

  let effectiveParent = parentStep;
  const parentWithinParallel = isInsideParallelBranch(effectiveParent);
  if (effectiveParent && !containsStep(effectiveParent, childStep) && !parentWithinParallel) {
    const childLoc = findParentAndIndex(mission, childStep);
    effectiveParent = childLoc?.parent ?? null;
  }

  let midStep = flow.lookups.nodeIdToStep.get(nodeId) ?? null;
  if (!midStep) {
    const adhocNode = flow.adHocNodes().find(n => n.id === nodeId);
    if (!adhocNode) return;
    midStep = missionStepFromAdHoc(adhocNode);
    flow.lookups.stepToNodeId.set(midStep, adhocNode.id);
    cleanupAdHocNode(flow, adhocNode.id);
  }

  if (midStep === effectiveParent || midStep === childStep) {
    return;
  }

  const parentLoc = effectiveParent ? findParentAndIndex(mission, effectiveParent) : null;
  if (
    effectiveParent &&
    parentLoc &&
    parentLoc.parent &&
    isType(parentLoc.parent, 'parallel') &&
    !(effectiveParent.children?.length) &&
    parentStep &&
    !containsStep(parentStep, childStep)
  ) {
    const seqWrapper = mk('seq');
    seqWrapper.children = [parentStep!, midStep];
    parentLoc.container.splice(parentLoc.index, 1, seqWrapper);
    rebuildFromMission(flow, mission);
    flow.layoutFlags.needsAdjust = true;
    flow.historyManager.recordHistory('split-mission-connection');
    return;
  }

  detachEverywhere(mission, midStep);
  if (insertBetween(mission, effectiveParent, childStep, midStep)) {
    rebuildFromMission(flow, mission);
    flow.layoutFlags.needsAdjust = true;
    flow.historyManager.recordHistory('split-mission-connection');
  }
}

export function handleAddBreakpoint(flow: Flowchart): void {
  const connectionId = flow.contextMenu.selectedConnectionId;
  if (!connectionId) return;

  const mission = flow.missionState.currentMission();
  if (!mission) return;

  const connection = flow.missionConnections().find(c => c.id === connectionId);
  if (!connection || connection.hasBreakpoint) return;

  const childNodeId = connection.targetNodeId;
  if (!childNodeId) return;

  const existingNodes = flow.nodes();
  const parentNode = connection.sourceNodeId ? existingNodes.find(n => n.id === connection.sourceNodeId) ?? null : null;
  const childNode = existingNodes.find(n => n.id === childNodeId) ?? null;
  const childStep = flow.lookups.nodeIdToStep.get(childNodeId);
  if (!childStep) return;

  const parentNodeId = connection.sourceNodeId ?? null;
  const parentStep = parentNodeId ? flow.lookups.nodeIdToStep.get(parentNodeId) ?? null : null;

  let storedPosition: { x: number; y: number } | undefined;
  if (childNode?.position) {
    storedPosition = { x: childNode.position.x, y: childNode.position.y };
  } else if (childStep.position) {
    storedPosition = {
      x: childStep.position.x ?? 0,
      y: childStep.position.y ?? 0,
    };
  } else if (parentNode?.position) {
    const orientation = flow.orientation();
    const parentHeight = flow.lookups.lastNodeHeights.get(parentNode.id) ?? 80;
    if (orientation === 'vertical') {
      storedPosition = {
        x: parentNode.position.x,
        y: parentNode.position.y + parentHeight + LAYOUT_SPACING.vertical.gap,
      };
    } else {
      storedPosition = {
        x: parentNode.position.x + parentHeight + LAYOUT_SPACING.horizontal.gap,
        y: parentNode.position.y,
      };
    }
  }

  const breakpointStep: MissionStep = {
    step_type: 'breakpoint',
    function_name: 'breakpoint',
    arguments: [],
    position: storedPosition,
    children: [childStep],
  };

  if (!insertBetween(mission, parentStep, childStep, breakpointStep)) {
    return;
  }

  rebuildFromMission(flow, mission);
  flow.layoutFlags.needsAdjust = true;
  flow.historyManager.recordHistory('add-breakpoint');
  flow.contextMenu.resetSelection();
  flow.cm?.hide();
}

export function handleRemoveBreakpoint(flow: Flowchart): void {
  const connectionId = flow.contextMenu.selectedConnectionId;
  if (!connectionId) return;

  const mission = flow.missionState.currentMission();
  if (!mission) return;

  const connection = flow.missionConnections().find(c => c.id === connectionId);
  if (!connection || !connection.hasBreakpoint) return;

  const breakpointPathKey = connection.breakpointPathKey;
  const breakpointStep = breakpointPathKey ? findStepByPath(mission, breakpointPathKey) : null;
  if (!breakpointStep || !isBreakpoint(breakpointStep)) return;

  const oldPosition = breakpointStep.position ? { ...breakpointStep.position } : null;
  const child = breakpointStep.children?.[0] ?? null;
  const loc = findParentAndIndex(mission, breakpointStep);
  if (!loc) return;

  const { container, index } = loc;
  if (!container) return;

  if (child) {
    if (oldPosition) {
      child.position = { ...oldPosition };
    }
    container.splice(index, 1, child);
  } else {
    container.splice(index, 1);
  }

  rebuildFromMission(flow, mission);
  flow.layoutFlags.needsAdjust = true;
  flow.historyManager.recordHistory('remove-breakpoint');
  flow.contextMenu.resetSelection();
  flow.cm?.hide();
}

function findStepByPath(mission: Mission, pathKey: string): MissionStep | null {
  if (!pathKey) return null;
  const indices = pathKey.split('.').map(part => Number.parseInt(part, 10) - 1);
  if (indices.some(num => Number.isNaN(num) || num < 0)) return null;

  let current: MissionStep | undefined;
  let container: MissionStep[] | undefined = mission.steps;

  for (const idx of indices) {
    if (!container || idx >= container.length) {
      return null;
    }
    current = container[idx];
    container = current.children;
  }
  return current ?? null;
}
