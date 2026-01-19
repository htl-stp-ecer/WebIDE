import { MissionStep } from '../../../../entities/MissionStep';
import { Waypoint } from './models';
import { Pose2D, normalizeAngle } from '../models';
import { LineSegmentCm } from '../services';
import { SensorConfig } from '../models';
import {
  closestLineNormalAngle,
  findClosestLineSegment,
  linePerpendicularScore,
  DEFAULT_LINE_PROXIMITY_CM,
} from './line-utils';

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

// --- Main Optimizer Function ---

/**
 * Convert waypoints to optimized mission steps.
 */
export function optimizeWaypointsToSteps(
  waypoints: Waypoint[],
  startPose: Pose2D,
  context: OptimizationContext,
  options?: OptimizationOptions
): MissionStep[] {
  if (waypoints.length < 2) return [];

  const useTankTurn = options?.useTankTurn ?? false;
  const minRotateDeg = options?.minRotateDeg ?? 1;
  const lineupThreshold = options?.lineupThreshold ?? 0.5;
  const lineSegments = context.lineSegments ?? [];
  const sensorCount = context.sensorConfig?.lineSensors?.length ?? 0;
  const canDriveUntil = sensorCount >= 1;
  const canLineup = sensorCount >= 2;

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
    const lineInfo = lineSegments.length
      ? findClosestLineSegment(lineSegments, to.x, to.y)
      : null;
    const lineNear = !!lineInfo && lineInfo.distance <= DEFAULT_LINE_PROXIMITY_CM;
    const linePerpScore = lineInfo ? linePerpendicularScore(targetHeading, lineInfo.angle) : 0;
    const canAlignToLine = lineNear && linePerpScore >= lineupThreshold;
    const endOnBlack = lineNear && context.isOnBlackLine(to.x, to.y);
    const startOnBlack = lineNear && context.isOnBlackLine(from.x, from.y);

    // Generate turn step if needed
    if (Math.abs(angleDeg) >= minRotateDeg) {
      steps.push(createTurnStep(Math.round(angleDeg), useTankTurn));
      currentHeading = targetHeading;
    }

    // Drive full segment distance
    if (totalDistance > 1) {
      if (canDriveUntil && canAlignToLine && endOnBlack && !startOnBlack) {
        steps.push(createDriveUntilStep('black'));
      } else {
        steps.push(createDriveStep(Math.round(totalDistance)));
      }

      if (canLineup && canAlignToLine && endOnBlack && lineInfo) {
        steps.push(createLineupStep('forward', 'black'));
        currentHeading = closestLineNormalAngle(currentHeading, lineInfo.angle);
      }
    }
  }

  return steps;
}

// --- Helper Functions ---

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

function createDriveUntilStep(color: 'black' | 'white'): MissionStep {
  return {
    step_type: '',
    function_name: color === 'black' ? 'drive_until_black' : 'drive_until_white',
    arguments: [],
    position: { x: 0, y: 0 },
    children: [],
  };
}

function createLineupStep(direction: 'forward' | 'backward', color: 'black' | 'white'): MissionStep {
  let functionName = 'forward_lineup_on_black';
  if (direction === 'forward' && color === 'black') functionName = 'forward_lineup_on_black';
  if (direction === 'forward' && color === 'white') functionName = 'forward_lineup_on_white';
  if (direction === 'backward' && color === 'black') functionName = 'backward_lineup_on_black';
  if (direction === 'backward' && color === 'white') functionName = 'backward_lineup_on_white';

  return {
    step_type: '',
    function_name: functionName,
    arguments: [],
    position: { x: 0, y: 0 },
    children: [],
  };
}
