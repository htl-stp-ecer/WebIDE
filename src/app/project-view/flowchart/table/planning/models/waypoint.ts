/**
 * Represents a waypoint in the planning path.
 * Coordinates are in table space (centimeters).
 */
export interface Waypoint {
  /** Unique identifier for this waypoint */
  id: string;
  /** X position in centimeters (0 = left edge) */
  x: number;
  /** Y position in centimeters (0 = bottom edge) */
  y: number;
  /** Whether this waypoint should end with a lineup */
  lineup?: boolean;
  /** Line segment index to align to when lineup is enabled */
  lineupLineIndex?: number;
  /** Action to take when snapped to a line */
  lineSnapAction?: 'lineup' | 'follow' | 'drive' | 'drive_until';
  /**
   * Explicit heading at this waypoint in degrees (table frame, 0° = +X axis).
   * Only meaningful in spline mode with explicit-heading sub-mode.
   * Undefined ⇒ heading follows the spline tangent.
   */
  headingDeg?: number;
}

let waypointCounter = 0;

/**
 * Create a new waypoint with a unique ID.
 */
export function createWaypoint(
  x: number,
  y: number,
  lineup = false,
  lineupLineIndex?: number,
  lineSnapAction?: 'lineup' | 'follow' | 'drive' | 'drive_until',
  headingDeg?: number
): Waypoint {
  return {
    id: `wp-${++waypointCounter}-${Date.now()}`,
    x,
    y,
    lineup,
    lineupLineIndex,
    lineSnapAction,
    headingDeg,
  };
}
