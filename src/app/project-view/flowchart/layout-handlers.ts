import type { Flowchart } from './flowchart';
import type { FlowNode } from './models';
import { LAYOUT_SPACING, START_NODE_ID, END_NODE_ID } from './constants';
import { computeAutoLayout } from './layout-utils';
import { isVerticalOrientation } from './orientation-handlers';
import { baseId } from './models';

export function handleAfterViewChecked(flow: Flowchart): void {
  if (!flow.useAutoLayout) {
    return;
  }

  const flags = flow.layoutFlags;
  if (flags.needsAdjust) {
    flags.needsAdjust = false;
    runAutoLayout(flow);
  }

  if (flags.pendingViewportReset) {
    flags.pendingViewportReset = false;
    flow.fCanvas()?.resetScaleAndCenter(false);
  }
}

export function handleLoaded(flow: Flowchart): void {
  const canvas = flow.fCanvas();
  if (!canvas) {
    return;
  }
  if (!flow.useAutoLayout) {
    canvas.emitCanvasChangeEvent();
    return;
  }
  if (!flow.viewportInitialized) {
    flow.viewportInitialized = true;
    canvas.resetScaleAndCenter(false);
  }
  canvas.emitCanvasChangeEvent();
}

export function startNodePosition(flow: Flowchart): { x: number; y: number } {
  if (isVerticalOrientation(flow)) {
    return { x: 300, y: 0 };
  }
  const height = getNodeHeight(flow, START_NODE_ID);
  return { x: 0, y: 300 - height / 2 };
}

export function endNodePosition(flow: Flowchart): { x: number; y: number } {
  const nodes = flow.nodes();
  const connections = flow.connections();
  const vertical = isVerticalOrientation(flow);

  // Find nodes that connect to the end node
  const endIncoming = connections.filter(c => c.inputId === 'end-node-input');
  const sourceNodeIds = endIncoming
    .map(c => c.sourceNodeId ?? baseId(c.outputId, 'output'))
    .filter(id => id !== START_NODE_ID);

  const sourceNodes = sourceNodeIds
    .map(id => nodes.find(n => n.id === id))
    .filter((n): n is FlowNode => !!n);

  if (!sourceNodes.length) {
    // Fallback: position below/right of start node
    const start = startNodePosition(flow);
    return vertical ? { x: start.x, y: start.y + 180 } : { x: start.x + 350, y: start.y };
  }

  const isJunction = (n: FlowNode) => n.id.startsWith('junction-') || n.step?.name === '__junction__';
  // Junctions are 0-width and positioned at center; regular nodes are 240px wide positioned at left edge
  const nodeWidth = DEFAULT_NODE_WIDTH;

  if (vertical) {
    const centerXs = sourceNodes.map(n => isJunction(n) ? n.position.x : n.position.x + nodeWidth / 2);
    const avgCenterX = centerXs.reduce((a, b) => a + b, 0) / centerXs.length;
    const maxY = Math.max(...sourceNodes.map(n => {
      const h = isJunction(n) ? 0 : (flow.lookups.lastNodeHeights.get(n.id) ?? 80);
      return n.position.y + h;
    }));
    // Position end node so its center aligns with avgCenterX
    return { x: avgCenterX - nodeWidth / 2, y: maxY + 75 };
  } else {
    const centerYs = sourceNodes.map(n => {
      const h = isJunction(n) ? 0 : (flow.lookups.lastNodeHeights.get(n.id) ?? 80);
      return isJunction(n) ? n.position.y : n.position.y + h / 2;
    });
    const avgCenterY = centerYs.reduce((a, b) => a + b, 0) / centerYs.length;
    const maxX = Math.max(...sourceNodes.map(n => isJunction(n) ? n.position.x : n.position.x + nodeWidth));
    return { x: maxX + 110, y: avgCenterY - 20 };
  }
}

export function getNodeHeight(flow: Flowchart, nodeId: string, fallback = 80): number {
  const cache = flow.lookups.lastNodeHeights.get(nodeId);
  if (cache !== undefined) {
    return cache;
  }

  let height = fallback;
  flow.nodeEls.forEach(el => {
    const id = el.nativeElement.dataset['nodeId'];
    if (id === nodeId) {
      height = el.nativeElement.offsetHeight || fallback;
    }
  });
  flow.lookups.lastNodeHeights.set(nodeId, height);
  return height;
}

export function updateHeightCache(flow: Flowchart): Map<string, number> {
  const map = new Map<string, number>();
  flow.nodeEls.forEach(el => {
    const id = el.nativeElement.dataset['nodeId'];
    if (id) {
      map.set(id, el.nativeElement.offsetHeight || 80);
    }
  });
  flow.lookups.updateHeightsSnapshot(map);
  return map;
}

export function runAutoLayout(flow: Flowchart): void {
  const mission = flow.missionState.currentMission();
  const heights = updateHeightCache(flow);
  const spacing = isVerticalOrientation(flow)
    ? LAYOUT_SPACING.vertical
    : LAYOUT_SPACING.horizontal;

  const laidOut = computeAutoLayout(
    mission,
    flow.nodes(),
    flow.lookups.stepToNodeId,
    heights,
    START_NODE_ID,
    flow.orientation(),
    spacing.laneWidth,
    LAYOUT_SPACING.vertical.gap,
    LAYOUT_SPACING.horizontal.gap
  );
  const withCollapsedOffsets = applyCollapsedGroupOffsets(flow, laidOut, heights);
  const withJunctions = repositionSyntheticJunctions(flow, withCollapsedOffsets, heights);
  flow.nodes.set(withJunctions);
  repositionParallelAutoGroups(flow, withJunctions, heights);
}

const PARALLEL_GROUP_PADDING = 24;
const PARALLEL_GROUP_HEADER_HEIGHT = 32;

function repositionParallelAutoGroups(
  flow: Flowchart,
  nodes: FlowNode[],
  heights: Map<string, number>,
): void {
  const groups = flow.groups();
  const autoGroups = groups.filter(g => g.id.startsWith('parallel-auto-'));
  if (!autoGroups.length) return;

  const byId = new Map(nodes.map(n => [n.id, n]));
  let changed = false;

  const updated = groups.map(group => {
    if (!group.id.startsWith('parallel-auto-')) return group;

    const memberNodes = group.nodeIds
      .map(id => byId.get(id))
      .filter((n): n is FlowNode => !!n);
    if (!memberNodes.length) return group;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of memberNodes) {
      const isJunction = n.id.startsWith('junction-') || n.step?.name === '__junction__';
      if (isJunction) {
        // Junctions are 0-size points — just include their center
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x);
        maxY = Math.max(maxY, n.position.y);
      } else {
        const h = heights.get(n.id) ?? flow.lookups.lastNodeHeights.get(n.id) ?? DEFAULT_NODE_HEIGHT;
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x + DEFAULT_NODE_WIDTH);
        maxY = Math.max(maxY, n.position.y + h);
      }
    }

    const newPos = {
      x: minX - PARALLEL_GROUP_PADDING,
      y: minY - PARALLEL_GROUP_PADDING - PARALLEL_GROUP_HEADER_HEIGHT,
    };
    const newSize = {
      width: maxX - minX + PARALLEL_GROUP_PADDING * 2,
      height: maxY - minY + PARALLEL_GROUP_PADDING * 2 + PARALLEL_GROUP_HEADER_HEIGHT,
    };

    changed = true;
    return { ...group, position: newPos, size: newSize };
  });

  if (changed) {
    flow.groups.set(updated);
  }
}

const DEFAULT_NODE_HEIGHT = 80;
const DEFAULT_NODE_WIDTH = 240;

function isSyntheticJunctionNode(node: FlowNode): boolean {
  return node.id.startsWith('junction-') || node.step?.name === '__junction__';
}

function repositionSyntheticJunctions(
  flow: Flowchart,
  nodes: FlowNode[],
  heights: Map<string, number>,
): FlowNode[] {
  const junctions = nodes.filter(node => isSyntheticJunctionNode(node));
  if (!junctions.length) {
    return nodes;
  }

  const byId = new Map(nodes.map(node => [node.id, node]));
  const startPos = startNodePosition(flow);
  const startHeight = heights.get(START_NODE_ID) ?? flow.lookups.lastNodeHeights.get(START_NODE_ID) ?? DEFAULT_NODE_HEIGHT;
  const orientation = isVerticalOrientation(flow) ? 'vertical' : 'horizontal';
  const connections = flow.connections();

  const getCenterX = (node: FlowNode): number => node.position.x + (isSyntheticJunctionNode(node) ? 0 : DEFAULT_NODE_WIDTH / 2);
  const getCenterY = (node: FlowNode): number => node.position.y + (heights.get(node.id) ?? flow.lookups.lastNodeHeights.get(node.id) ?? DEFAULT_NODE_HEIGHT) / 2;
  const getTopY = (node: FlowNode): number => node.position.y;
  const getBottomY = (node: FlowNode): number =>
    node.position.y + (heights.get(node.id) ?? flow.lookups.lastNodeHeights.get(node.id) ?? DEFAULT_NODE_HEIGHT);
  const getLeftX = (node: FlowNode): number => node.position.x;
  const getRightX = (node: FlowNode): number => node.position.x + (isSyntheticJunctionNode(node) ? 0 : DEFAULT_NODE_WIDTH);

  const updates = new Map<string, { x: number; y: number }>();

  junctions.forEach(junction => {
    const incoming = connections.filter(
      conn => (conn.targetNodeId ?? baseId(conn.inputId, 'input')) === junction.id,
    );
    const outgoing = connections.filter(
      conn => (conn.sourceNodeId ?? baseId(conn.outputId, 'output')) === junction.id,
    );

    const incomingNodes = incoming
      .map(conn => conn.sourceNodeId ?? baseId(conn.outputId, 'output'))
      .map(sourceId => sourceId === START_NODE_ID ? null : byId.get(sourceId))
      .filter((node): node is FlowNode => !!node);
    const outgoingNodes = outgoing
      .map(conn => conn.targetNodeId ?? baseId(conn.inputId, 'input'))
      .map(targetId => byId.get(targetId))
      .filter((node): node is FlowNode => !!node);

    if (!incoming.length && !outgoing.length) {
      return;
    }

    if (orientation === 'vertical') {
      const xCandidates = [
        ...incomingNodes.map(getCenterX),
        ...outgoingNodes.map(getCenterX),
      ];
      const incomingBottoms = incomingNodes.map(getBottomY);
      if (incoming.some(conn => (conn.sourceNodeId ?? baseId(conn.outputId, 'output')) === START_NODE_ID)) {
        incomingBottoms.push(startPos.y + startHeight);
      }
      const outgoingTops = outgoingNodes.map(getTopY);

      const x = xCandidates.length
        ? xCandidates.reduce((sum, value) => sum + value, 0) / xCandidates.length
        : junction.position.x;
      let y = junction.position.y;
      if (incomingBottoms.length && outgoingTops.length) {
        y = (Math.max(...incomingBottoms) + Math.min(...outgoingTops)) / 2;
      } else if (incomingBottoms.length) {
        y = Math.max(...incomingBottoms) + 40;
      } else if (outgoingTops.length) {
        y = Math.min(...outgoingTops) - 40;
      }
      updates.set(junction.id, { x, y });
      return;
    }

    const yCandidates = [
      ...incomingNodes.map(getCenterY),
      ...outgoingNodes.map(getCenterY),
    ];
    const incomingRights = incomingNodes.map(getRightX);
    if (incoming.some(conn => (conn.sourceNodeId ?? baseId(conn.outputId, 'output')) === START_NODE_ID)) {
      incomingRights.push(startPos.x + DEFAULT_NODE_WIDTH);
    }
    const outgoingLefts = outgoingNodes.map(getLeftX);

    let x = junction.position.x;
    if (incomingRights.length && outgoingLefts.length) {
      x = (Math.max(...incomingRights) + Math.min(...outgoingLefts)) / 2;
    } else if (incomingRights.length) {
      x = Math.max(...incomingRights) + 40;
    } else if (outgoingLefts.length) {
      x = Math.min(...outgoingLefts) - 40;
    }
    const y = yCandidates.length
      ? yCandidates.reduce((sum, value) => sum + value, 0) / yCandidates.length
      : junction.position.y;
    updates.set(junction.id, { x, y });
  });

  if (!updates.size) {
    return nodes;
  }

  return nodes.map(node => {
    const nextPos = updates.get(node.id);
    return nextPos ? { ...node, position: nextPos } : node;
  });
}

function applyCollapsedGroupOffsets(flow: Flowchart, nodes: FlowNode[], heights: Map<string, number>): FlowNode[] {
  if (!isVerticalOrientation(flow)) {
    return nodes;
  }
  const collapsedGroups = flow.groups().filter(group => group.collapsed);
  if (!collapsedGroups.length) {
    return nodes;
  }

  const resolveGroupNodeIds = (group: { nodeIds: string[]; stepPaths: string[] }): string[] => {
    const nodeIds = Array.isArray(group.nodeIds) ? group.nodeIds.filter(id => !!id) : [];
    if (nodeIds.length) {
      return nodeIds;
    }
    const stepPaths = Array.isArray(group.stepPaths) ? group.stepPaths.filter(path => !!path) : [];
    if (!stepPaths.length) {
      return [];
    }
    return stepPaths
      .map((pathKey: string) => flow.lookups.pathToNodeId.get(pathKey))
      .filter((id: string | undefined): id is string => typeof id === 'string' && !!id);
  };

  const sortedGroups = collapsedGroups.slice().sort((a, b) => a.position.y - b.position.y);
  let updated = nodes;

  for (const group of sortedGroups) {
    const groupNodeIds = new Set(resolveGroupNodeIds(group));
    if (!groupNodeIds.size) {
      continue;
    }

    let contentBottom = -Infinity;
    for (const node of updated) {
      if (!groupNodeIds.has(node.id)) {
        continue;
      }
      const height = heights.get(node.id) ?? flow.lookups.lastNodeHeights.get(node.id) ?? DEFAULT_NODE_HEIGHT;
      contentBottom = Math.max(contentBottom, node.position.y + height);
    }
    if (!Number.isFinite(contentBottom)) {
      continue;
    }

    const collapsedBottom = group.position.y + group.size.height;
    const deltaY = contentBottom - collapsedBottom;
    if (deltaY <= 0) {
      continue;
    }

    updated = shiftNodesBelow(updated, contentBottom, deltaY, groupNodeIds);
  }

  return updated;
}

function shiftNodesBelow(nodes: FlowNode[], thresholdY: number, deltaY: number, excludedIds: Set<string>): FlowNode[] {
  let changed = false;
  const next = nodes.map(node => {
    if (excludedIds.has(node.id)) {
      return node;
    }
    if (node.position.y < thresholdY) {
      return node;
    }
    changed = true;
    return { ...node, position: { x: node.position.x, y: node.position.y - deltaY } };
  });
  return changed ? next : nodes;
}
