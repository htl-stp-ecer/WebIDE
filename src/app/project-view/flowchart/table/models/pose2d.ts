/**
 * Represents a 2D robot pose with position (cm) and heading (radians).
 * Heading 0 = facing +X direction.
 */
export interface Pose2D {
  /** X position in centimeters */
  x: number;
  /** Y position in centimeters */
  y: number;
  /** Heading angle in radians. 0 = +X direction, positive = CCW */
  theta: number;
}

export function createPose(x: number, y: number, thetaDeg: number): Pose2D {
  return { x, y, theta: normalizeAngle(thetaDeg * Math.PI / 180) };
}

export function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

export function thetaToDegrees(theta: number): number {
  return theta * 180 / Math.PI;
}

/**
 * Apply a delta in the robot's local frame.
 */
export function applyLocalDelta(
  pose: Pose2D,
  dxLocal: number,
  dyLocal: number,
  dTheta: number
): Pose2D {
  const cos = Math.cos(pose.theta);
  const sin = Math.sin(pose.theta);
  const worldDx = dxLocal * cos - dyLocal * sin;
  const worldDy = dxLocal * sin + dyLocal * cos;
  return {
    x: pose.x + worldDx,
    y: pose.y + worldDy,
    theta: normalizeAngle(pose.theta + dTheta),
  };
}

/**
 * Move forward (or backward if negative) along current heading.
 */
export function forwardMove(pose: Pose2D, distanceCm: number): Pose2D {
  const dx = distanceCm * Math.cos(pose.theta);
  const dy = distanceCm * Math.sin(pose.theta);
  return { x: pose.x + dx, y: pose.y + dy, theta: pose.theta };
}

/**
 * Strafe perpendicular to heading (positive = left).
 */
export function strafe(pose: Pose2D, distanceCm: number): Pose2D {
  const perpAngle = pose.theta + Math.PI * 0.5;
  const dx = distanceCm * Math.cos(perpAngle);
  const dy = distanceCm * Math.sin(perpAngle);
  return { x: pose.x + dx, y: pose.y + dy, theta: pose.theta };
}

/**
 * Rotate by given angle in radians (positive = CCW).
 */
export function rotate(pose: Pose2D, angleRad: number): Pose2D {
  return { x: pose.x, y: pose.y, theta: normalizeAngle(pose.theta + angleRad) };
}

/**
 * Get the forward direction vector.
 */
export function getForward(pose: Pose2D): { x: number; y: number } {
  return { x: Math.cos(pose.theta), y: Math.sin(pose.theta) };
}

/**
 * Linearly interpolate between two poses.
 */
export function lerpPose(a: Pose2D, b: Pose2D, t: number): Pose2D {
  const angleDiff = normalizeAngle(b.theta - a.theta);
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    theta: normalizeAngle(a.theta + angleDiff * t),
  };
}
