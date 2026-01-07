import type { Flowchart } from './flowchart';
import type { FlowNode } from './models';
import { LAYOUT_SPACING, START_NODE_ID } from './constants';
import { computeAutoLayout } from './layout-utils';
import { isVerticalOrientation } from './orientation-handlers';

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
  canvas.resetScaleAndCenter(false);
  canvas.emitCanvasChangeEvent();
}

export function startNodePosition(flow: Flowchart): { x: number; y: number } {
  if (isVerticalOrientation(flow)) {
    return { x: 300, y: 0 };
  }
  const height = getNodeHeight(flow, START_NODE_ID);
  return { x: 0, y: 300 - height / 2 };
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
  flow.nodes.set(applyCollapsedGroupOffsets(flow, laidOut, heights));
}

const DEFAULT_NODE_HEIGHT = 80;

function applyCollapsedGroupOffsets(flow: Flowchart, nodes: FlowNode[], heights: Map<string, number>): FlowNode[] {
  if (!isVerticalOrientation(flow)) {
    return nodes;
  }
  const collapsedGroups = flow.groups().filter(group => group.collapsed);
  if (!collapsedGroups.length) {
    return nodes;
  }

  const sortedGroups = collapsedGroups.slice().sort((a, b) => a.position.y - b.position.y);
  let updated = nodes;

  for (const group of sortedGroups) {
    const groupNodeIds = new Set(group.nodeIds);
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
