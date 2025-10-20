import type { Flowchart } from './flowchart';
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
  flow.nodes.set(laidOut);
}
