import { MissionStep } from '../../../../entities/MissionStep';
import { Waypoint } from './models';
import { normalizeAngle } from '../models';
import {
  driveUntilColorFromStepId,
  FlowStepId,
  isDriveStepId,
  isFollowLineStepId,
  isLineupStepId,
  isTurnStepId,
  lineupColorFromStepId,
  lineupDirectionFromStepId,
  stepId,
} from '../step-id';

export interface ConversionOptions {
  /** Initial robot heading in radians (default: 0 = facing +X) */
  startHeading?: number;
  /** Use tank_turn_cw/tank_turn_ccw instead of turn_cw/turn_ccw (default: false) */
  useTankTurn?: boolean;
  /** Minimum rotation angle in degrees to generate a turn step (default: 1) */
  minRotateDeg?: number;
}

/**
 * Convert a sequence of waypoints to mission steps.
 * Generates turn_cw/turn_ccw and drive_forward commands to navigate between points.
 */
export function waypointsToMissionSteps(
  waypoints: Waypoint[],
  options?: ConversionOptions
): MissionStep[] {
  if (waypoints.length < 2) return [];

  const startHeading = options?.startHeading ?? 0;
  const useTankTurn = options?.useTankTurn ?? false;
  const minRotateDeg = options?.minRotateDeg ?? 1;

  const steps: MissionStep[] = [];
  let currentHeading = startHeading;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const from = waypoints[i];
    const to = waypoints[i + 1];

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 0.1) continue; // Skip very small movements

    // Calculate required heading to face the next waypoint
    const targetHeading = Math.atan2(dy, dx);
    const angleDiff = normalizeAngle(targetHeading - currentHeading);
    const angleDeg = angleDiff * (180 / Math.PI);

    // Generate turn step if needed (positive = CCW, negative = CW)
    if (Math.abs(angleDeg) >= minRotateDeg) {
      steps.push(createTurnStep(Math.round(angleDeg), useTankTurn));
      currentHeading = targetHeading;
    }

    // Generate drive step
    steps.push(createDriveStep(Math.round(distance)));
  }

  return steps;
}

/**
 * Create a turn step (turn_cw or turn_ccw based on angle sign).
 * Positive angle = counter-clockwise, negative = clockwise.
 */
function createTurnStep(angleDeg: number, useTank: boolean): MissionStep {
  const isClockwise = angleDeg < 0;
  const functionName = useTank
    ? (isClockwise ? FlowStepId.TankTurnCw : FlowStepId.TankTurnCcw)
    : (isClockwise ? FlowStepId.TurnCw : FlowStepId.TurnCcw);

  return {
    step_type: functionName,
    function_name: functionName,
    arguments: [
      {
        name: 'deg',
        value: Math.abs(angleDeg),
        type: 'float',
      },
    ],
    position: { x: 0, y: 0 },
    children: [],
  };
}

/**
 * Create a drive_forward step.
 */
function createDriveStep(distanceCm: number): MissionStep {
  return {
    step_type: FlowStepId.DriveForward,
    function_name: FlowStepId.DriveForward,
    arguments: [
      {
        name: 'cm',
        value: distanceCm,
        type: 'float',
      },
    ],
    position: { x: 0, y: 0 },
    children: [],
  };
}

/**
 * Convert waypoints to a single SplinePath mission step.
 *
 * Waypoints are given in table-frame cm. The Python `spline_path()` step
 * expects waypoints relative to the robot's start pose, as (forward_cm,
 * left_cm) tuples — optionally with an explicit heading in degrees.
 *
 * The serialized argument is a JSON string under the name `waypoints` with
 * type `list`, since MissionStep arguments are scalar-only.
 */
export function waypointsToSplineStep(
  waypoints: Waypoint[],
  options: {
    startX: number;
    startY: number;
    startHeading: number;
    speed?: number;
    useExplicitHeadings?: boolean;
    finalHeadingDeg?: number | null;
    absoluteHeading?: boolean;
  }
): MissionStep | null {
  if (waypoints.length < 2) return null;

  const {
    startX,
    startY,
    startHeading,
    speed = 1.0,
    useExplicitHeadings = false,
    finalHeadingDeg = null,
    absoluteHeading = false,
  } = options;

  const cos = Math.cos(-startHeading);
  const sin = Math.sin(-startHeading);

  const tuples: number[][] = waypoints.map((wp) => {
    const dx = wp.x - startX;
    const dy = wp.y - startY;
    // Rotate into robot frame: forward = +X', left = +Y'
    const fwd = dx * cos - dy * sin;
    const left = dx * sin + dy * cos;
    if (useExplicitHeadings && typeof wp.headingDeg === 'number') {
      const relHeadingDeg = absoluteHeading
        ? wp.headingDeg
        : wp.headingDeg - (startHeading * 180) / Math.PI;
      return [fwd, left, relHeadingDeg];
    }
    return [fwd, left];
  });

  const args: MissionStep['arguments'] = [
    {
      name: 'waypoints',
      value: JSON.stringify(tuples),
      type: 'list',
    },
    {
      name: 'speed',
      value: speed,
      type: 'float',
    },
  ];

  if (finalHeadingDeg !== null && finalHeadingDeg !== undefined && !useExplicitHeadings) {
    args.push({ name: 'final_heading_deg', value: finalHeadingDeg, type: 'float' });
    args.push({ name: 'absolute_heading', value: absoluteHeading, type: 'bool' });
  }

  return {
    step_type: FlowStepId.SplinePath,
    function_name: FlowStepId.SplinePath,
    arguments: args,
    position: { x: 0, y: 0 },
    children: [],
  };
}

/**
 * Format a step for display in the preview panel.
 */
export function formatStepForPreview(step: MissionStep): string {
  const fn = stepId(step);
  const display = step.function_name || step.step_type || fn;
  const arg = step.arguments[0];

  // Lineup steps have no arguments
  if (isLineupStepId(fn)) {
    const direction = lineupDirectionFromStepId(fn);
    const color = lineupColorFromStepId(fn);
    if (direction && color) {
      return direction === 'backward' ? `lineup_bwd(${color})` : `lineup(${color})`;
    }
    return display;
  }
  const driveUntilColor = driveUntilColorFromStepId(fn);
  if (driveUntilColor) return `drive_until(${driveUntilColor})`;
  if (isFollowLineStepId(fn)) {
    if (!arg) return 'follow_line';
    return `follow_line(${arg.value}cm)`;
  }

  if (!arg) return display;

  if (isTurnStepId(fn)) {
    return `${display}(${arg.value}°)`;
  }
  if (isDriveStepId(fn)) {
    return `${display}(${arg.value}cm)`;
  }
  if (fn === FlowStepId.SplinePath) {
    const wpArg = step.arguments.find((a) => a.name === 'waypoints');
    const speedArg = step.arguments.find((a) => a.name === 'speed');
    let count = 0;
    try {
      const parsed = wpArg ? JSON.parse(String(wpArg.value)) : [];
      count = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      count = 0;
    }
    const speed = speedArg?.value ?? 1;
    return `spline_path(${count} pts, speed=${speed})`;
  }
  return `${display}(${arg.value})`;
}
