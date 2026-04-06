export const START_NODE_ID = 'start-node' as const;
export const START_OUTPUT_ID = 'start-node-output' as const;
export const END_NODE_ID = 'end-node' as const;
export const END_INPUT_ID = 'end-node-input' as const;

export const LAYOUT_SPACING = {
  vertical: { laneWidth: 275, gap: 75 },
  horizontal: { laneWidth: 275, gap: 350 },
} as const;
