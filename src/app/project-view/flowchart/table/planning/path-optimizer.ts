import { MissionStep } from '../../../../entities/MissionStep';
import { Waypoint } from './models';
import { Pose2D, normalizeAngle } from '../models';
import { LineSegmentCm } from '../services';
import { SensorConfig } from '../models';

// --- Lineup Angle Thresholds ---
const MIN_LINEUP_ANGLE_DEG = 20;         // Minimum approach angle at threshold 0
const MAX_LINEUP_ANGLE_DEG = 85;         // Minimum approach angle at threshold 1
const SENSOR_FIT_MULTIPLIER = 1.5;       // Line must be >= sensor spacing * this

// --- Interfaces ---

export interface OptimizationContext {
  lineSegments: LineSegmentCm[];
  sensorConfig: SensorConfig;
  isOnBlackLine: (x: number, y: number) => boolean;
}

export interface OptimizationOptions {
  /** Lineup angle threshold: 0=permissive, 1=strict (default: 0.5) */
  lineupThreshold?: number;
  /** Use tank turn functions (default: false) */
  useTankTurn?: boolean;
  /** Minimum rotation in degrees to generate turn step (default: 1) */
  minRotateDeg?: number;
}

interface LineCrossing {
  position: { x: number; y: number };
  lineSegment: LineSegmentCm;
  distanceFromStart: number;
  lineAngle: number;
  approachAngle: number;
}

interface LineupFeasibility {
  canLineup: boolean;
  reason?: string;
  lineColor: 'black' | 'white';
}

// --- Main Optimizer Function ---

/**
 * Convert waypoints to optimized mission steps with lineup injection.
 */
export function optimizeWaypointsToSteps(
  waypoints: Waypoint[],
  startPose: Pose2D,
  context: OptimizationContext,
  options?: OptimizationOptions
): MissionStep[] {
  if (waypoints.length < 2) return [];

  const threshold = options?.lineupThreshold ?? 0.5;
  const lineupAngleThreshold = getLineupAngleThreshold(threshold);
  const useTankTurn = options?.useTankTurn ?? false;
  const minRotateDeg = options?.minRotateDeg ?? 1;

  const steps: MissionStep[] = [];
  let currentHeading = startPose.theta;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const from = waypoints[i];
    const to = waypoints[i + 1];

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const totalDistance = Math.sqrt(dx * dx + dy * dy);

    if (totalDistance < 0.1) continue;

    // Calculate required heading
    const targetHeading = Math.atan2(dy, dx);
    const angleDiff = normalizeAngle(targetHeading - currentHeading);
    const angleDeg = angleDiff * (180 / Math.PI);

    // Generate turn step if needed
    if (Math.abs(angleDeg) >= minRotateDeg) {
      steps.push(createTurnStep(Math.round(angleDeg), useTankTurn));
      currentHeading = targetHeading;
    }

    // Find line crossings along this segment
    const crossings = findLineCrossings(from, to, context.lineSegments, targetHeading);

    // Sort crossings by distance from start
    crossings.sort((a, b) => a.distanceFromStart - b.distanceFromStart);

    // Process segment with potential lineup injections
    let distanceTraveled = 0;
    let lineupInjected = false;

    for (const crossing of crossings) {
      if (lineupInjected) {
        continue;
      }

      const feasibility = checkLineupFeasibility(
        crossing,
        context.sensorConfig,
        context.isOnBlackLine,
        lineupAngleThreshold
      );

      if (feasibility.canLineup) {
        // Lineup automatically drives to the line and aligns - no manual drive needed
        steps.push(createLineupStep(feasibility.lineColor, 'forward'));
        distanceTraveled = crossing.distanceFromStart;
        lineupInjected = true;
      }
    }

    // Drive remaining distance
    const remainingDistance = totalDistance - distanceTraveled;
    if (remainingDistance > 1) {
      steps.push(createDriveStep(Math.round(remainingDistance)));
    }
  }

  return steps;
}

// --- Helper Functions ---

/**
 * Find all line crossings along a path segment.
 */
function findLineCrossings(
  from: Waypoint,
  to: Waypoint,
  lineSegments: LineSegmentCm[],
  pathHeading: number
): LineCrossing[] {
  const crossings: LineCrossing[] = [];

  for (const line of lineSegments) {
    const intersection = lineIntersection(
      from.x, from.y, to.x, to.y,
      line.startX, line.startY, line.endX, line.endY
    );

    if (intersection) {
      const distanceFromStart = Math.sqrt(
        Math.pow(intersection.x - from.x, 2) + Math.pow(intersection.y - from.y, 2)
      );

      const lineAngle = Math.atan2(line.endY - line.startY, line.endX - line.startX);
      const approachAngle = Math.abs(normalizeAngle(pathHeading - lineAngle)) * (180 / Math.PI);
      // Convert to angle from perpendicular (0 = perpendicular, 90 = parallel)
      const angleFromPerpendicular = Math.abs(90 - approachAngle);

      crossings.push({
        position: intersection,
        lineSegment: line,
        distanceFromStart,
        lineAngle,
        approachAngle: 90 - angleFromPerpendicular, // Degrees from parallel
      });
    }
  }

  return crossings;
}

/**
 * Line-line intersection using parametric form.
 */
function lineIntersection(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number
): { x: number; y: number } | null {
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 0.0001) return null;

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      x: x1 + t * (x2 - x1),
      y: y1 + t * (y2 - y1),
    };
  }
  return null;
}

/**
 * Check if lineup is feasible at a crossing.
 */
function checkLineupFeasibility(
  crossing: LineCrossing,
  sensorConfig: SensorConfig,
  isOnBlackLine: (x: number, y: number) => boolean,
  minApproachAngleDeg: number
): LineupFeasibility {
  // Check approach angle (must be roughly perpendicular)
  if (crossing.approachAngle < minApproachAngleDeg) {
    return { canLineup: false, reason: 'approach_angle_too_shallow', lineColor: 'black' };
  }

  // Check sensor fit
  const sensorSpacing = getSensorSpacing(sensorConfig);
  const lineLength = segmentLength(crossing.lineSegment);
  if (lineLength < sensorSpacing * SENSOR_FIT_MULTIPLIER) {
    return { canLineup: false, reason: 'line_too_short_for_sensors', lineColor: 'black' };
  }

  // Always use black lineup to keep a single lineup function.
  return { canLineup: true, lineColor: 'black' };
}

function getLineupAngleThreshold(threshold: number): number {
  const clamped = Math.max(0, Math.min(1, threshold));
  return MIN_LINEUP_ANGLE_DEG + (MAX_LINEUP_ANGLE_DEG - MIN_LINEUP_ANGLE_DEG) * clamped;
}

/**
 * Get the spacing between left and right sensors.
 */
function getSensorSpacing(sensorConfig: SensorConfig): number {
  if (sensorConfig.lineSensors.length < 2) return 0;

  const sorted = [...sensorConfig.lineSensors].sort((a, b) => a.strafeCm - b.strafeCm);
  const right = sorted[0];
  const left = sorted[sorted.length - 1];

  return Math.abs(left.strafeCm - right.strafeCm);
}

/**
 * Calculate the length of a line segment.
 */
function segmentLength(segment: LineSegmentCm): number {
  return Math.sqrt(
    Math.pow(segment.endX - segment.startX, 2) +
    Math.pow(segment.endY - segment.startY, 2)
  );
}

// --- Step Creation Functions ---

function createTurnStep(angleDeg: number, useTank: boolean): MissionStep {
  const isClockwise = angleDeg < 0;
  const functionName = useTank
    ? (isClockwise ? 'tank_turn_cw' : 'tank_turn_ccw')
    : (isClockwise ? 'turn_cw' : 'turn_ccw');

  return {
    step_type: '',
    function_name: functionName,
    arguments: [{ name: 'deg', value: Math.abs(angleDeg), type: 'float' }],
    position: { x: 0, y: 0 },
    children: [],
  };
}

function createDriveStep(distanceCm: number): MissionStep {
  return {
    step_type: '',
    function_name: 'drive_forward',
    arguments: [{ name: 'cm', value: distanceCm, type: 'float' }],
    position: { x: 0, y: 0 },
    children: [],
  };
}

function createLineupStep(lineColor: 'black' | 'white', direction: 'forward' | 'backward'): MissionStep {
  const functionName = `${direction}_lineup_on_${lineColor}`;

  return {
    step_type: '',
    function_name: functionName,
    arguments: [],
    position: { x: 0, y: 0 },
    children: [],
  };
}
