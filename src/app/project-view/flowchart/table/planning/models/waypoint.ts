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
}

let waypointCounter = 0;

/**
 * Create a new waypoint with a unique ID.
 */
export function createWaypoint(x: number, y: number): Waypoint {
  return {
    id: `wp-${++waypointCounter}-${Date.now()}`,
    x,
    y,
  };
}
