export interface LayoutFlags {
  needsAdjust: boolean;
  pendingViewportReset: boolean;
}

export function createLayoutFlags(): LayoutFlags {
  return {
    needsAdjust: false,
    pendingViewportReset: false,
  };
}
