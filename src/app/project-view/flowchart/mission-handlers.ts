import type { Flowchart } from './flowchart';
import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { MissionComment } from '../../entities/MissionComment';
import { rebuildMissionView } from './mission-builder';
import { asStepFromPool, initialArgsFromPool } from './step-utils';
import { recomputeMergedView } from './view-merger';
import { START_OUTPUT_ID } from './constants';
import { FlowComment } from './models';

function toFlowComments(comments: MissionComment[] | undefined): FlowComment[] {
  if (!Array.isArray(comments)) {
    return [];
  }
  return comments
    .filter((c): c is MissionComment => !!c)
    .map((comment) => ({
      id: comment.id,
      text: comment.text ?? '',
      position: {
        x: comment.position?.x ?? 0,
        y: comment.position?.y ?? 0,
      },
      beforePath: comment.before_path ?? null,
      afterPath: comment.after_path ?? null,
    }));
}

function toMissionComments(comments: FlowComment[]): MissionComment[] {
  return comments.map((comment) => ({
    id: comment.id,
    text: comment.text,
    position: { x: comment.position.x, y: comment.position.y },
    before_path: comment.beforePath ?? null,
    after_path: comment.afterPath ?? null,
  }));
}

export function computeStepPaths(flow: Flowchart, mission: Mission | null): void {
  flow.lookups.stepPaths.clear();
  if (!mission) {
    return;
  }

  const visit = (steps: MissionStep[] | undefined, prefix: number[]) => {
    (steps ?? []).forEach((step, idx) => {
      const path = [...prefix, idx + 1];
      flow.lookups.stepPaths.set(step, path);
      if (step.children?.length) {
        visit(step.children, path);
      }
    });
  };

  visit(mission.steps, []);
}

export function rebuildFromMission(flow: Flowchart, mission: Mission): void {
  computeStepPaths(flow, mission);

  const previous = new Map(flow.lookups.stepToNodeId);
  const steps = flow.stepsState.currentSteps() ?? [];

  const result = rebuildMissionView(
    mission,
    previous,
    ms => asStepFromPool(ms, steps),
    ms => initialArgsFromPool(ms, steps),
    START_OUTPUT_ID,
    ms => flow.lookups.stepPaths.get(ms)
  );

  flow.lookups.setNodeLookups(result.stepToNodeId, result.nodeIdToStep);
  flow.lookups.setPathLookups(result.pathToNodeId, result.pathToConnectionIds);
  flow.runManager.updatePathLookups(flow.lookups.pathToNodeId, flow.lookups.pathToConnectionIds);
  flow.missionNodes.set(result.nodes);
  flow.missionConnections.set(result.connections);
  const flowComments = toFlowComments(mission.comments);
  flow.comments.set(flowComments);
  mission.comments = toMissionComments(flowComments);
  recomputeMergedView(flow);
  flow.runManager.clearRunVisuals();
}

export function handleNodeMoved(flow: Flowchart, nodeId: string, pos: { x: number; y: number }): void {
  const update = (signal: typeof flow.adHocNodes | typeof flow.missionNodes) => {
    const nodes = signal();
    const index = nodes.findIndex(n => n.id === nodeId);
    if (index === -1) {
      return false;
    }
    const copy = nodes.slice();
    copy[index] = { ...copy[index], position: { x: pos.x, y: pos.y } };
    signal.set(copy);
    if (signal === flow.missionNodes) {
      const step = flow.lookups.nodeIdToStep.get(nodeId);
      if (step && !flow.useAutoLayout) {
        step.position = { x: pos.x, y: pos.y };
      }
    }
    return true;
  };

  if (!update(flow.adHocNodes) && !update(flow.missionNodes)) {
    return;
  }
  recomputeMergedView(flow);
  flow.historyManager.recordHistory('move-node');
}
