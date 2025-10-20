import type { Flowchart } from './flowchart';
import type { FlowOrientation } from './models';

export function handleOrientationChange(flow: Flowchart, value: FlowOrientation | null): void {
  if (!value || value === flow.orientation()) {
    return;
  }
  flow.orientation.set(value);
  flow.layoutFlags.needsAdjust = true;
  flow.layoutFlags.pendingViewportReset = true;
}

export function isVerticalOrientation(flow: Flowchart): boolean {
  return flow.orientation() === 'vertical';
}
