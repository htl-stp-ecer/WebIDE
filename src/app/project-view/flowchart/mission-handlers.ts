import type { Flowchart } from './flowchart';
import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { MissionComment } from '../../entities/MissionComment';
import { MissionGroup } from '../../entities/MissionGroup';
import { rebuildMissionView } from './mission-builder';
import { asStepFromPool, initialArgsFromPool } from './step-utils';
import { recomputeMergedView } from './view-merger';
import { START_OUTPUT_ID } from './constants';
import { FlowComment, FlowGroup, FlowNode } from './models';

const DEFAULT_GROUP_SIZE = { width: 360, height: 240 };

function normalizeFlowGroups(groups: FlowGroup[]): FlowGroup[] {
  return (groups ?? [])
    .filter((g): g is FlowGroup => !!g && typeof (g as any).id === 'string' && !!(g as any).id)
    .map(g => ({
      id: g.id,
      title: (g as any).title ?? 'Group',
      position: (g as any).position && Number.isFinite((g as any).position.x) && Number.isFinite((g as any).position.y)
        ? { x: (g as any).position.x, y: (g as any).position.y }
        : { x: 0, y: 0 },
      size: (g as any).size && Number.isFinite((g as any).size.width) && Number.isFinite((g as any).size.height)
        ? { width: (g as any).size.width, height: (g as any).size.height }
        : { width: DEFAULT_GROUP_SIZE.width, height: DEFAULT_GROUP_SIZE.height },
      collapsed: !!(g as any).collapsed,
      nodeIds: Array.isArray((g as any).nodeIds)
        ? (g as any).nodeIds.filter((id: unknown): id is string => typeof id === 'string' && !!id)
        : [],
      stepPaths: Array.isArray((g as any).stepPaths)
        ? (g as any).stepPaths.filter((p: unknown): p is string => typeof p === 'string' && !!p)
        : [],
      expandedSize: (g as any).expandedSize ?? null,
    }));
}

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

function toFlowGroups(flow: Flowchart, groups: MissionGroup[] | undefined): FlowGroup[] {
  if (!Array.isArray(groups)) {
    return [];
  }
  return groups
    .filter((g): g is MissionGroup => !!g && typeof g.id === 'string' && !!g.id)
    .map((group) => ({
      id: group.id,
      title: group.title ?? 'Group',
      position: { x: group.position?.x ?? 0, y: group.position?.y ?? 0 },
      size: {
        width: group.size?.width ?? DEFAULT_GROUP_SIZE.width,
        height: group.size?.height ?? DEFAULT_GROUP_SIZE.height,
      },
      collapsed: !!group.collapsed,
      nodeIds: (Array.isArray(group.step_paths) ? group.step_paths : [])
        .map(pathKey => flow.lookups.pathToNodeId.get(pathKey))
        .filter((id): id is string => typeof id === 'string' && !!id),
      stepPaths: Array.isArray(group.step_paths) ? group.step_paths.filter((p): p is string => typeof p === 'string' && !!p) : [],
      expandedSize: null,
    }));
}

function toMissionGroups(groups: FlowGroup[]): MissionGroup[] {
  return groups.map((group) => ({
    id: group.id,
    title: group.title,
    position: { x: group.position.x, y: group.position.y },
    size: { width: group.size.width, height: group.size.height },
    collapsed: group.collapsed,
    step_paths: group.stepPaths,
  }));
}

function refreshGroupStepPaths(flow: Flowchart, groups: FlowGroup[]): FlowGroup[] {
  const getStepPath = (nodeId: string): string | null => {
    const step = flow.lookups.nodeIdToStep.get(nodeId);
    const path = step ? flow.lookups.stepPaths.get(step) : undefined;
    return path && path.length ? path.join('.') : null;
  };
  return groups.map(group => ({
    ...group,
    stepPaths: group.nodeIds
      .map(id => getStepPath(id))
      .filter((p): p is string => typeof p === 'string' && !!p),
  }));
}

export function computeStepPaths(flow: Flowchart, mission: Mission | null): void {
  flow.lookups.stepPaths.clear();
  if (!mission) {
    return;
  }

  const visited = new Set<MissionStep>();
  const visit = (steps: MissionStep[] | undefined, prefix: number[]) => {
    (steps ?? []).forEach((step, idx) => {
      if (visited.has(step)) {
        return;
      }
      visited.add(step);
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
  const existingGroups = flow.groups();
  const loadedGroups = normalizeFlowGroups(existingGroups.length ? existingGroups : toFlowGroups(flow, mission.groups));
  const refreshedGroups = refreshGroupStepPaths(flow, loadedGroups);
  flow.groups.set(refreshedGroups);
  mission.groups = toMissionGroups(refreshedGroups);
  recomputeMergedView(flow);
  flow.runManager.clearRunVisuals();
}

export function handleNodeMoved(flow: Flowchart, nodeId: string, pos: { x: number; y: number }): void {
  let touched = false;
  let missionNodeMoved = false;

  const updatePositions = (nodes: FlowNode[], isMission: boolean) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    node.position = { x: pos.x, y: pos.y };
    touched = true;
    if (isMission) missionNodeMoved = true;
  };

  updatePositions(flow.adHocNodes(), false);
  updatePositions(flow.missionNodes(), true);
  updatePositions(flow.nodes(), false);

  if (!touched) {
    return;
  }

  if (missionNodeMoved) {
    const step = flow.lookups.nodeIdToStep.get(nodeId);
    if (step && !flow.useAutoLayout) {
      step.position = { x: pos.x, y: pos.y };
    }
  }

  flow.historyManager.recordHistory('move-node');
}
