import { MissionStep } from '../../../../entities/MissionStep';
import { Waypoint } from './models';
import { normalizeAngle } from '../models';

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
    ? (isClockwise ? 'tank_turn_cw' : 'tank_turn_ccw')
    : (isClockwise ? 'turn_cw' : 'turn_ccw');

  return {
    step_type: '',
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
    step_type: '',
    function_name: 'drive_forward',
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
 * Format a step for display in the preview panel.
 */
export function formatStepForPreview(step: MissionStep): string {
  const fn = step.function_name;
  const arg = step.arguments[0];

  // Lineup steps have no arguments
  if (fn.includes('lineup')) {
    // Shorten the name for display
    if (fn === 'forward_lineup_on_black') return 'lineup(black)';
    if (fn === 'forward_lineup_on_white') return 'lineup(white)';
    if (fn === 'backward_lineup_on_black') return 'lineup_bwd(black)';
    if (fn === 'backward_lineup_on_white') return 'lineup_bwd(white)';
    return fn;
  }
  if (fn === 'drive_until_black') return 'drive_until(black)';
  if (fn === 'drive_until_white') return 'drive_until(white)';

  if (!arg) return fn;

  if (fn === 'turn_cw' || fn === 'turn_ccw' || fn === 'tank_turn_cw' || fn === 'tank_turn_ccw') {
    return `${fn}(${arg.value}°)`;
  }
  if (fn === 'drive_forward' || fn === 'drive_backward') {
    return `${fn}(${arg.value}cm)`;
  }
  return `${fn}(${arg.value})`;
}
