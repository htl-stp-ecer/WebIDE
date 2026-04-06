import type { Flowchart } from './flowchart';
import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { MissionComment } from '../../entities/MissionComment';
import { MissionGroup } from '../../entities/MissionGroup';
import { rebuildMissionView, ParallelGroupInfo } from './mission-builder';
import { asStepFromPool, canonicalizeMissionStepArguments, initialArgsFromPool } from './step-utils';
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
    .filter((g): g is MissionGroup => !!g && !!g.id)
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
      stepPaths: Array.isArray(group.step_paths) ? group.step_paths.filter((p): p is string => !!p) : [],
      expandedSize: group.expanded_size
        ? {
          width: group.expanded_size.width ?? (group.size?.width ?? DEFAULT_GROUP_SIZE.width),
          height: group.expanded_size.height ?? (group.size?.height ?? DEFAULT_GROUP_SIZE.height),
        }
        : null,
    }));
}

function toMissionGroups(groups: FlowGroup[]): MissionGroup[] {
  return groups.map((group) => ({
    id: group.id,
    title: group.title,
    position: { x: group.position.x, y: group.position.y },
    size: { width: group.size.width, height: group.size.height },
    expanded_size: group.expandedSize
      ? { width: group.expandedSize.width, height: group.expandedSize.height }
      : undefined,
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
  return groups.map(group => {
    if (!group.nodeIds.length && group.stepPaths.length) {
      return group;
    }
    return {
      ...group,
      stepPaths: group.nodeIds
        .map(id => getStepPath(id))
        .filter((p): p is string => typeof p === 'string' && !!p),
    };
  });
}

function hydrateGroupNodeIds(flow: Flowchart, groups: FlowGroup[], missionGroups?: MissionGroup[]): FlowGroup[] {
  const missionLookup = new Map((missionGroups ?? []).map(group => [group.id, group]));
  return groups.map(group => {
    const fallbackPaths = missionLookup.get(group.id)?.step_paths ?? [];
    const stepPaths = group.stepPaths.length ? group.stepPaths : fallbackPaths;
    if (!stepPaths.length) {
      return group;
    }
    const nodeIds = stepPaths
      .map(pathKey => flow.lookups.pathToNodeId.get(pathKey))
      .filter((id): id is string => typeof id === 'string' && !!id);
    if (!nodeIds.length) {
      return { ...group, stepPaths };
    }
    return { ...group, nodeIds, stepPaths };
  });
}

function mergeGroupStepPaths(groups: FlowGroup[], fallback: FlowGroup[]): FlowGroup[] {
  const fallbackMap = new Map(fallback.map(group => [group.id, group]));
  return groups.map(group => {
    if (group.stepPaths.length) {
      return group;
    }
    const fallbackGroup = fallbackMap.get(group.id);
    if (!fallbackGroup || !fallbackGroup.stepPaths.length) {
      return group;
    }
    return {
      ...group,
      stepPaths: fallbackGroup.stepPaths,
    };
  });
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

const PARALLEL_GROUP_PREFIX = 'parallel-auto-';
const PARALLEL_GROUP_PADDING = 24;
const PARALLEL_GROUP_HEADER_HEIGHT = 40;

function buildAutoParallelGroups(
  parallelGroups: ParallelGroupInfo[],
  nodes: FlowNode[],
): FlowGroup[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const result: FlowGroup[] = [];

  for (const pg of parallelGroups) {
    const allGroupNodes = pg.nodeIds
      .map(id => byId.get(id))
      .filter((n): n is FlowNode => !!n);
    if (!allGroupNodes.length) continue;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of allGroupNodes) {
      const isJunction = n.step?.name === '__junction__';
      if (isJunction) {
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x);
        maxY = Math.max(maxY, n.position.y);
      } else {
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x + 240);
        maxY = Math.max(maxY, n.position.y + 80);
      }
    }

    result.push({
      id: `${PARALLEL_GROUP_PREFIX}${pg.pathKey}`,
      title: 'Parallel',
      position: {
        x: minX - PARALLEL_GROUP_PADDING,
        y: minY - PARALLEL_GROUP_PADDING - PARALLEL_GROUP_HEADER_HEIGHT,
      },
      size: {
        width: maxX - minX + PARALLEL_GROUP_PADDING * 2,
        height: maxY - minY + PARALLEL_GROUP_PADDING * 2 + PARALLEL_GROUP_HEADER_HEIGHT,
      },
      collapsed: false,
      nodeIds: pg.nodeIds.filter(id => byId.has(id)),
      stepPaths: [],
      expandedSize: null,
    });
  }

  return result;
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

  // Build auto-groups for parallel steps
  const autoGroups = buildAutoParallelGroups(result.parallelGroups, result.nodes);
  const autoGroupIds = new Set(autoGroups.map(g => g.id));

  // Merge with user-created groups (filter out old auto-groups)
  const existingGroups = flow.groups().filter(g => !g.id.startsWith(PARALLEL_GROUP_PREFIX));
  const missionGroups = toFlowGroups(flow, mission.groups).filter(g => !g.id.startsWith(PARALLEL_GROUP_PREFIX));
  const loadedGroups = normalizeFlowGroups(existingGroups.length ? existingGroups : missionGroups);
  const mergedGroups = mergeGroupStepPaths(loadedGroups, missionGroups);
  const hydratedGroups = hydrateGroupNodeIds(flow, mergedGroups, mission.groups);
  const refreshedGroups = refreshGroupStepPaths(flow, hydratedGroups);

  // Combine user groups + auto parallel groups
  flow.groups.set([...refreshedGroups, ...autoGroups]);
  flow.rebuildParallelGroupLookup();
  mission.groups = toMissionGroups(refreshedGroups); // Only persist user groups
  recomputeMergedView(flow);
  flow.runManager.clearRunVisuals();
}

export function handleNodeMoved(flow: Flowchart, nodeId: string, pos: { x: number; y: number }): void {
  const applyPositions = (id: string, nextPos: { x: number; y: number }) => {
    const updatePositions = (nodes: FlowNode[], isMission: boolean) => {
      const node = nodes.find(n => n.id === id);
      if (!node) return false;
      node.position = { x: nextPos.x, y: nextPos.y };
      if (isMission) {
        const step = flow.lookups.nodeIdToStep.get(id);
        if (step && !flow.useAutoLayout) {
          step.position = { x: nextPos.x, y: nextPos.y };
        }
      }
      return true;
    };
    const touchedMission = updatePositions(flow.missionNodes(), true);
    const touchedAdHoc = updatePositions(flow.adHocNodes(), false);
    const touchedMerged = updatePositions(flow.nodes(), false);
    return touchedMission || touchedAdHoc || touchedMerged;
  };

  if (applyPositions(nodeId, pos)) {
    flow.historyManager.recordHistory('move-node');
    flow.syncSelectionGroup();
  }
}

/**
 * Add planned steps (from planning mode) to the current mission.
 */
export function handleAddPlannedSteps(flow: Flowchart, steps: MissionStep[]): void {
  if (!steps.length) return;

  const mission = flow.missionState.currentMission();
  if (!mission) return;
  const pool = flow.stepsState.currentSteps() ?? [];
  const normalizedSteps = steps.map(step => canonicalizeMissionStepArguments(step, pool));

  // Append steps to mission
  mission.steps = [...(mission.steps ?? []), ...normalizedSteps];

  rebuildFromMission(flow, mission);
  flow.layoutFlags.needsAdjust = true;
  flow.historyManager.recordHistory('add-planned-steps');
  flow.updatePlannedPathForMission?.(mission);
}
