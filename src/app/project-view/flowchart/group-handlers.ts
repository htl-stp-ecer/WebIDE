import type { Flowchart } from './flowchart';
import type { IPoint } from '@foblex/2d';
import { generateGuid } from '@foblex/utils';
import { baseId, FlowGroup } from './models';
import { MissionGroup } from '../../entities/MissionGroup';
import { toCanvasPoint } from './comment-handlers';
import type { FDropToGroupEvent } from '@foblex/flow';
import type { Connection, FlowNode } from './models';
import { recomputeMergedView } from './view-merger';

const DEFAULT_GROUP_SIZE = { width: 360, height: 240 };
const COLLAPSED_GROUP_HEIGHT = 44;
const COLLAPSED_GROUP_MIN_WIDTH = 160;
const DEFAULT_NODE_SIZE = { width: 240, height: 80 };

function normalizeNodeIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((id): id is string => typeof id === 'string' && !!id);
}

function stableHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function shiftIfBelow<T extends { position: { x: number; y: number } }>(items: T[], thresholdY: number, deltaY: number, exclude?: (item: T) => boolean): T[] {
  let changed = false;
  const next = items.map(item => {
    if (exclude?.(item)) {
      return item;
    }
    if (item.position.y < thresholdY) {
      return item;
    }
    changed = true;
    return { ...item, position: { x: item.position.x, y: item.position.y + deltaY } };
  });
  return changed ? next : items;
}

function updateMissionStepPositions(flow: Flowchart, nodeIds: Set<string>, deltaY: number): void {
  if (deltaY === 0) {
    return;
  }
  const mission = flow.missionState.currentMission();
  if (!mission || flow.useAutoLayout) {
    return;
  }
  for (const nodeId of nodeIds) {
    const step = flow.lookups.nodeIdToStep.get(nodeId);
    if (step?.position) {
      step.position = { x: step.position.x, y: step.position.y + deltaY };
    }
  }
}

function getNodeElementSize(flow: Flowchart, nodeId: string): { width: number; height: number } {
  const fallback = { ...DEFAULT_NODE_SIZE };
  const els = flow.nodeEls?.toArray?.() ?? [];
  for (const ref of els) {
    const el = ref?.nativeElement;
    if (!el) {
      continue;
    }
    const id = el.dataset['nodeId'];
    if (id === nodeId) {
      const width = el.offsetWidth || fallback.width;
      const height = el.offsetHeight || fallback.height;
      return { width, height };
    }
  }
  return fallback;
}

function buildNodeElementSizeMap(flow: Flowchart): Map<string, { width: number; height: number }> {
  const map = new Map<string, { width: number; height: number }>();
  const els = flow.nodeEls?.toArray?.() ?? [];
  for (const ref of els) {
    const el = ref?.nativeElement;
    if (!el) {
      continue;
    }
    const id = el.dataset['nodeId'];
    if (!id) {
      continue;
    }
    map.set(id, {
      width: el.offsetWidth || DEFAULT_NODE_SIZE.width,
      height: el.offsetHeight || DEFAULT_NODE_SIZE.height,
    });
  }
  return map;
}

function getNodeStepPathKey(flow: Flowchart, nodeId: string): string | null {
  const step = flow.lookups.nodeIdToStep.get(nodeId);
  const path = step ? flow.lookups.stepPaths.get(step) : undefined;
  if (path && path.length) {
    return path.join('.');
  }
  const node = flow.missionNodes().find(n => n.id === nodeId);
  if (node?.path?.length) {
    return node.path.join('.');
  }
  return null;
}

function fillGroupNodeIdsFromPaths(flow: Flowchart, group: FlowGroup): FlowGroup {
  const current = normalizeNodeIds((group as any).nodeIds);
  if (current.length) {
    return group;
  }
  const stepPaths = Array.isArray((group as any).stepPaths) ? (group as any).stepPaths : [];
  if (!stepPaths.length) {
    return group;
  }
  const nodeIds = stepPaths
    .map((pathKey: string) => flow.lookups.pathToNodeId.get(pathKey))
    .filter((id: string | undefined): id is string => typeof id === 'string' && !!id);
  if (!nodeIds.length) {
    return group;
  }
  return { ...group, nodeIds, stepPaths };
}

function resolveGroupNodeIds(flow: Flowchart, group: FlowGroup): string[] {
  const nodeIds = normalizeNodeIds((group as any).nodeIds);
  if (nodeIds.length) {
    return nodeIds;
  }
  const stepPaths = Array.isArray((group as any).stepPaths) ? (group as any).stepPaths : [];
  if (!stepPaths.length) {
    return [];
  }
  return stepPaths
    .map((pathKey: string) => flow.lookups.pathToNodeId.get(pathKey))
    .filter((id: string | undefined): id is string => typeof id === 'string' && !!id);
}

function getNodesUnderGroup(flow: Flowchart, group: FlowGroup, candidates: FlowNode[]): string[] {
  const groupSize = group.collapsed
    ? (group.expandedSize ?? group.size)
    : group.size;
  const left = group.position.x;
  const top = group.position.y;
  const right = left + groupSize.width;
  const bottom = top + groupSize.height;
  const sizeMap = buildNodeElementSizeMap(flow);

  return candidates
    .filter(node => {
      const size = sizeMap.get(node.id) ?? getNodeElementSize(flow, node.id);
      const centerX = node.position.x + size.width / 2;
      const centerY = node.position.y + size.height / 2;
      return centerX >= left && centerX <= right && centerY >= top && centerY <= bottom;
    })
    .map(node => node.id);
}

function fillGroupNodeIdsFromGeometry(flow: Flowchart, group: FlowGroup, candidates: FlowNode[]): FlowGroup {
  const current = normalizeNodeIds((group as any).nodeIds);
  if (current.length) {
    return group;
  }
  const nodesUnderGroup = getNodesUnderGroup(flow, group, candidates);
  if (!nodesUnderGroup.length) {
    return group;
  }
  const stepPaths = nodesUnderGroup
    .map(id => getNodeStepPathKey(flow, id))
    .filter((p): p is string => typeof p === 'string' && !!p);
  return { ...group, nodeIds: nodesUnderGroup, stepPaths };
}

function getGroupContentBottom(flow: Flowchart, nodes: FlowNode[], groupNodeIds: Set<string>): number | null {
  if (!groupNodeIds.size) {
    return null;
  }
  const sizeMap = buildNodeElementSizeMap(flow);
  let contentBottom = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    if (!groupNodeIds.has(node.id)) {
      continue;
    }
    const size = sizeMap.get(node.id) ?? getNodeElementSize(flow, node.id);
    const height = size.height || DEFAULT_NODE_SIZE.height;
    contentBottom = Math.max(contentBottom, node.position.y + height);
  }
  return Number.isFinite(contentBottom) ? contentBottom : null;
}

function applyAutoAssignNodesToGroup(flow: Flowchart, groups: FlowGroup[], targetGroupId: string, strict = false): FlowGroup[] {
  const targetIndex = groups.findIndex(g => g.id === targetGroupId);
  if (targetIndex === -1) {
    return groups;
  }

  const target = groups[targetIndex]!;
  const currentTargetNodeIds = resolveGroupNodeIds(flow, target);
  const visibleNodes = getVisibleNodes(flow);
  const visibleNodeIds = new Set(visibleNodes.map(n => n.id));
  const candidates = flow.nodes().filter(node => visibleNodeIds.has(node.id) || currentTargetNodeIds.includes(node.id));

  const nodesUnderGroup = getNodesUnderGroup(flow, target, candidates);
  if (!strict && !nodesUnderGroup.length) {
    return groups;
  }

  const nextTargetNodeIds = strict
    ? nodesUnderGroup
    : Array.from(new Set([...currentTargetNodeIds, ...nodesUnderGroup]));
  const nodesToClaim = new Set(nextTargetNodeIds);

  let changed = false;
  const updated = groups.map(group => {
    const currentNodeIds = normalizeNodeIds((group as any).nodeIds);
    if (group.id === targetGroupId) {
      if (currentNodeIds.length !== nextTargetNodeIds.length || currentNodeIds.some((id, idx) => id !== nextTargetNodeIds[idx])) {
        changed = true;
      }
      return {
        ...group,
        nodeIds: nextTargetNodeIds,
        stepPaths: nextTargetNodeIds
          .map(id => getNodeStepPathKey(flow, id))
          .filter((p): p is string => typeof p === 'string' && !!p),
      };
    }

    const filtered = currentNodeIds.filter(id => !nodesToClaim.has(id));
    if (filtered.length !== currentNodeIds.length) {
      changed = true;
      return {
        ...group,
        nodeIds: filtered,
        stepPaths: filtered
          .map(id => getNodeStepPathKey(flow, id))
          .filter((p): p is string => typeof p === 'string' && !!p),
      };
    }
    return group;
  });

  return changed ? updated : groups;
}

function syncMissionGroups(flow: Flowchart, groups: FlowGroup[]): void {
  const mission = flow.missionState.currentMission();
  if (!mission) {
    return;
  }
  mission.groups = groups.map(
    (group): MissionGroup => ({
      id: group.id,
      title: group.title,
      position: { x: group.position.x, y: group.position.y },
      size: { width: group.size.width, height: group.size.height },
      expanded_size: group.expandedSize
        ? { width: group.expandedSize.width, height: group.expandedSize.height }
        : undefined,
      collapsed: group.collapsed,
      step_paths: normalizeNodeIds((group as any).nodeIds)
        .map(id => getNodeStepPathKey(flow, id))
        .filter((p): p is string => typeof p === 'string' && !!p),
    }),
  );
}

export function handleGroupRightClick(flow: Flowchart, event: MouseEvent, groupId: string): void {
  if (flow.contextMenuOnPointerUp) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (flow.shouldSuppressContextMenu(event) || flow.consumeContextMenuSuppression()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  flow.contextMenu.selectGroup(groupId, { clientX: event.clientX, clientY: event.clientY });
  flow.contextMenu.setItems(flow.contextMenu.groupItems);
  flow.cm.show(event);
}

export function createGroupFromContextMenu(flow: Flowchart): void {
  const position = flow.contextMenu.eventPosition;
  if (!position) {
    return;
  }
  addGroup(flow, toCanvasPoint(flow, position));
  flow.cm.hide();
  flow.contextMenu.eventPosition = null;
}

export function addGroup(flow: Flowchart, point: IPoint): void {
  const id = `group-${generateGuid()}`;
  const group: FlowGroup = {
    id,
    title: 'Group',
    position: { x: point.x, y: point.y },
    size: { ...DEFAULT_GROUP_SIZE },
    collapsed: false,
    nodeIds: [],
    stepPaths: [],
    expandedSize: null,
  };
  const updated = [...flow.groups(), group];
  flow.groups.set(updated);
  syncMissionGroups(flow, updated);
  flow.contextMenu.selectedGroupId = id;
  flow.historyManager.recordHistory('create-group');
}

export function handleGroupPositionChanged(flow: Flowchart, groupId: string, pos: IPoint): void {
  if (!pos || !Number.isFinite((pos as any).x) || !Number.isFinite((pos as any).y)) {
    return;
  }
  const groups = flow.groups();
  const index = groups.findIndex(g => g.id === groupId);
  if (index === -1) {
    return;
  }
  const updated = groups.slice();
  updated[index] = { ...updated[index], position: { x: pos.x, y: pos.y } };
  const withAutoGrouped = applyAutoAssignNodesToGroup(flow, updated, groupId, true);
  flow.groups.set(withAutoGrouped);
  syncMissionGroups(flow, withAutoGrouped);
  flow.historyManager.recordHistory('move-group');
}

export function handleGroupSizeChanged(flow: Flowchart, groupId: string, rect: { width: number; height: number }): void {
  if (!rect) {
    return;
  }
  const groups = flow.groups();
  const index = groups.findIndex(g => g.id === groupId);
  if (index === -1) {
    return;
  }
  const updated = groups.slice();
  const current = updated[index];
  if (current.collapsed) {
    return;
  }
  const width = Number.isFinite(rect.width) ? rect.width : current.size.width;
  const height = Number.isFinite(rect.height) ? rect.height : current.size.height;
  if (Math.abs(width - current.size.width) < 0.5 && Math.abs(height - current.size.height) < 0.5) {
    return;
  }
  updated[index] = {
    ...current,
    size: { width, height },
    expandedSize: current.collapsed ? current.expandedSize : null,
  };
  const withAutoGrouped = applyAutoAssignNodesToGroup(flow, updated, groupId, true);
  flow.groups.set(withAutoGrouped);
  syncMissionGroups(flow, withAutoGrouped);
  flow.historyManager.recordHistory('resize-group');
}

export function toggleGroupCollapsed(flow: Flowchart, groupId: string): void {
  const groupsBefore = flow.groups();
  const index = groupsBefore.findIndex(g => g.id === groupId);
  if (index === -1) {
    return;
  }

  const isAutoLayout = flow.useAutoLayout;
  const nodesBefore = flow.nodes();
  const missionNodesBefore = flow.missionNodes();
  const adHocNodesBefore = flow.adHocNodes();
  const commentsBefore = flow.comments();

  let groups = groupsBefore.slice();
  let nodes = nodesBefore;
  let missionNodes = missionNodesBefore;
  let adHocNodes = adHocNodesBefore;
  let comments = commentsBefore;

  const withPathNodes = fillGroupNodeIdsFromPaths(flow, groups[index]!);
  const withGeometryNodes = fillGroupNodeIdsFromGeometry(flow, withPathNodes, flow.nodes());
  if (withGeometryNodes !== groups[index]) {
    groups[index] = withGeometryNodes;
  }
  const groupBefore = groups[index]!;
  const isVertical = flow.orientation() === 'vertical';
  const nodeIdsInGroup = new Set(resolveGroupNodeIds(flow, groupBefore));
  const contentBottom = isAutoLayout ? getGroupContentBottom(flow, nodes, nodeIdsInGroup) : null;

  const applyShift = (thresholdY: number, deltaY: number) => {
    if (!isVertical || deltaY === 0 || isAutoLayout) {
      return;
    }
    const excludeNode = (node: FlowNode) => nodeIdsInGroup.has(node.id);
    missionNodes = shiftIfBelow(missionNodes, thresholdY, deltaY, excludeNode);
    adHocNodes = shiftIfBelow(adHocNodes, thresholdY, deltaY, excludeNode);
    comments = shiftIfBelow(comments, thresholdY, deltaY);
    groups = shiftIfBelow(groups, thresholdY, deltaY, g => (g as any).id === groupId);

    const shiftedMissionIds = new Set(
      missionNodes
        .filter((n, i) => n.position.y !== missionNodesBefore[i]?.position.y)
        .map(n => n.id),
    );
    updateMissionStepPositions(flow, shiftedMissionIds, deltaY);
  };

  const groupNow = () => groups.find(g => g.id === groupId);

  if (groupBefore.collapsed) {
    const g = groupNow() ?? groupBefore;
    const restoreSize = g.expandedSize ?? g.size;
    const collapseHeight = g.size.height;
    const deltaY = isAutoLayout && contentBottom !== null
      ? (contentBottom - (g.position.y + collapseHeight))
      : (restoreSize.height - collapseHeight);
    const thresholdY = isAutoLayout && contentBottom !== null
      ? contentBottom
      : (g.position.y + collapseHeight);

    applyShift(thresholdY, deltaY);

    const nextGroup = groupNow() ?? g;
    groups = groups.map(existing => existing.id === groupId
      ? { ...nextGroup, collapsed: false, size: { ...restoreSize }, expandedSize: null }
      : existing);
  } else {
    const g = groupNow() ?? groupBefore;
    const expandedSize = g.expandedSize ?? g.size;
    const deltaY = isAutoLayout && contentBottom !== null
      ? (contentBottom - (g.position.y + COLLAPSED_GROUP_HEIGHT))
      : (expandedSize.height - COLLAPSED_GROUP_HEIGHT);
    const thresholdY = isAutoLayout && contentBottom !== null
      ? contentBottom
      : (g.position.y + expandedSize.height);

    applyShift(thresholdY, -deltaY);

    const nextGroup = groupNow() ?? g;
    groups = groups.map(existing => existing.id === groupId
      ? {
        ...nextGroup,
        collapsed: true,
        expandedSize,
        size: {
          width: Math.max(COLLAPSED_GROUP_MIN_WIDTH, expandedSize.width),
          height: COLLAPSED_GROUP_HEIGHT,
        },
      }
      : existing);
  }

  flow.comments.set(comments);
  flow.groups.set(groups);
  if (isAutoLayout) {
    flow.nodes.set(nodes);
    flow.layoutFlags.needsAdjust = true;
  } else {
    flow.missionNodes.set(missionNodes);
    flow.adHocNodes.set(adHocNodes);
    recomputeMergedView(flow);
  }
  syncMissionGroups(flow, groups);
  flow.historyManager.recordHistory('toggle-group');
}

export function deleteGroup(flow: Flowchart): void {
  const id = flow.contextMenu.selectedGroupId;
  if (!id) {
    return;
  }
  const before = flow.groups().length;
  const updated = flow.groups().filter(g => g.id !== id);
  flow.groups.set(updated);
  flow.contextMenu.selectedGroupId = '';
  if (updated.length !== before) {
    syncMissionGroups(flow, updated);
    flow.historyManager.recordHistory('delete-group');
  }
}

export function handleDropToGroup(flow: Flowchart, event: FDropToGroupEvent): void {
  const targetGroupId = event.fTargetNode;
  const groups = flow.groups();
  const targetIndex = groups.findIndex(g => g.id === targetGroupId);
  if (targetIndex === -1) {
    return;
  }

  const allNodeIds = new Set(flow.nodes().map(n => n.id));
  const draggedIds = (event.fNodes ?? [])
    .filter((id): id is string => !!id)
    .filter(id => allNodeIds.has(id));
  if (!draggedIds.length) {
    return;
  }

  const updated = groups.map(group => ({
    ...group,
    nodeIds: normalizeNodeIds((group as any).nodeIds).filter(id => !draggedIds.includes(id)),
  }));
  const target = updated[targetIndex]!;
  const merged = Array.from(new Set([...normalizeNodeIds((target as any).nodeIds), ...draggedIds]));
  updated[targetIndex] = { ...target, nodeIds: merged };
  flow.groups.set(updated);
  syncMissionGroups(flow, updated);
  flow.historyManager.recordHistory('drop-to-group');
}

export function removeSelectedNodeFromGroups(flow: Flowchart): void {
  const nodeId = flow.contextMenu.selectedNodeId;
  if (!nodeId) {
    return;
  }
  removeNodeFromGroups(flow, nodeId, true);
}

export function removeNodeFromGroups(flow: Flowchart, nodeId: string, recordHistory: boolean): void {
  const groups = flow.groups();
  const updated = groups.map(group => ({
    ...group,
    nodeIds: normalizeNodeIds((group as any).nodeIds).filter(id => id !== nodeId),
  }));
  const changed = updated.some((g, idx) => g.nodeIds.length !== normalizeNodeIds((groups[idx] as any)?.nodeIds).length);
  if (!changed) {
    return;
  }
  flow.groups.set(updated);
  syncMissionGroups(flow, updated);
  if (recordHistory) {
    flow.historyManager.recordHistory('remove-from-group');
  }
}

export function getNodeParentGroupId(flow: Flowchart, node: FlowNode): string | null {
  if (!node?.id) {
    return null;
  }
  const group = flow.groups().find(g => resolveGroupNodeIds(flow, g).includes(node.id));
  return group?.id ?? null;
}

export function isNodeHiddenByCollapsedGroup(flow: Flowchart, node: FlowNode): boolean {
  const group = flow.groups().find(g => g.collapsed && resolveGroupNodeIds(flow, g).includes(node.id));
  return !!group;
}

export function getVisibleNodes(flow: Flowchart): FlowNode[] {
  return flow.nodes().filter(node => !isNodeHiddenByCollapsedGroup(flow, node));
}

export function getVisibleConnections(flow: Flowchart): Connection[] {
  const visibleNodeIds = new Set(getVisibleNodes(flow).map(n => n.id));
  const connections = flow.connections();

  const visible = connections.filter(conn => {
    const sourceNodeId = baseId(conn.outputId, 'output');
    const targetNodeId = baseId(conn.inputId, 'input');
    const sourceOk = sourceNodeId === 'start-node' || visibleNodeIds.has(sourceNodeId);
    const targetOk = visibleNodeIds.has(targetNodeId);
    return sourceOk && targetOk;
  });

  const byEndpoints = new Set(visible.map(conn => `${conn.outputId}→${conn.inputId}`));
  const bridged: Connection[] = [];

  const collapsedGroups = flow.groups().filter(g => g.collapsed);
  for (const group of collapsedGroups) {
    const groupNodeIds = new Set(resolveGroupNodeIds(flow, group));
    if (!groupNodeIds.size) {
      continue;
    }

    const incomingOutputIds = new Set<string>();
    const outgoingInputIds = new Set<string>();

    for (const conn of connections) {
      const sourceNodeId = baseId(conn.outputId, 'output');
      const targetNodeId = baseId(conn.inputId, 'input');
      const sourceInGroup = groupNodeIds.has(sourceNodeId);
      const targetInGroup = groupNodeIds.has(targetNodeId);

      if (!sourceInGroup && targetInGroup) {
        const sourceOk = sourceNodeId === 'start-node' || visibleNodeIds.has(sourceNodeId);
        if (sourceOk) {
          incomingOutputIds.add(conn.outputId);
        }
      } else if (sourceInGroup && !targetInGroup) {
        const targetOk = visibleNodeIds.has(targetNodeId);
        if (targetOk) {
          outgoingInputIds.add(conn.inputId);
        }
      }
    }

    if (!incomingOutputIds.size || !outgoingInputIds.size) {
      continue;
    }

    for (const outputId of incomingOutputIds) {
      for (const inputId of outgoingInputIds) {
        const key = `${outputId}→${inputId}`;
        if (byEndpoints.has(key)) {
          continue;
        }
        byEndpoints.add(key);
        bridged.push({
          id: `collapsed-${group.id}-${stableHash(key)}`,
          outputId,
          inputId,
        });
      }
    }
  }

  return [...visible, ...bridged];
}
