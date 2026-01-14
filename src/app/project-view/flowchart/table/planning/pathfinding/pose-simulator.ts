import { Pose2D, forwardMove, rotate, normalizeAngle } from '../../models/pose2d';
import { MissionStep } from '../../../../../entities/MissionStep';

/**
 * Simulate the resulting pose from executing a command.
 * This is a lightweight computation without backend calls.
 */
export function simulateCommand(startPose: Pose2D, command: MissionStep): Pose2D {
  const fn = command.function_name;
  const arg = command.arguments[0]?.value as number ?? 0;

  switch (fn) {
    case 'drive_forward':
      return forwardMove(startPose, arg);

    case 'drive_backward':
      return forwardMove(startPose, -arg);

    case 'turn_cw':
    case 'tank_turn_cw':
      // Clockwise = negative angle (in radians)
      return rotate(startPose, -arg * Math.PI / 180);

    case 'turn_ccw':
    case 'tank_turn_ccw':
      // Counter-clockwise = positive angle
      return rotate(startPose, arg * Math.PI / 180);

    case 'strafe_left':
      // Strafe perpendicular to heading (left = positive perpendicular)
      return strafeMove(startPose, arg);

    case 'strafe_right':
      return strafeMove(startPose, -arg);

    default:
      // Unknown command - return unchanged pose
      return { ...startPose };
  }
}

/**
 * Move perpendicular to heading (positive = left).
 */
function strafeMove(pose: Pose2D, distanceCm: number): Pose2D {
  const perpAngle = pose.theta + Math.PI * 0.5;
  const dx = distanceCm * Math.cos(perpAngle);
  const dy = distanceCm * Math.sin(perpAngle);
  return { x: pose.x + dx, y: pose.y + dy, theta: pose.theta };
}

/**
 * Simulate a sequence of commands and return the final pose.
 */
export function simulateCommands(startPose: Pose2D, commands: MissionStep[]): Pose2D {
  let pose = startPose;
  for (const cmd of commands) {
    pose = simulateCommand(pose, cmd);
  }
  return pose;
}

/**
 * Get all intermediate poses from a command sequence.
 */
export function getCommandTrajectory(startPose: Pose2D, commands: MissionStep[]): Pose2D[] {
  const poses: Pose2D[] = [startPose];
  let pose = startPose;
  for (const cmd of commands) {
    pose = simulateCommand(pose, cmd);
    poses.push(pose);
  }
  return poses;
}

/**
 * Get trajectory with intermediate steps for a single command.
 * This allows physics simulation to properly handle wall sliding.
 */
export function getSingleCommandTrajectory(startPose: Pose2D, command: MissionStep, stepSize: number = 1): Pose2D[] {
  const fn = command.function_name;
  const arg = command.arguments[0]?.value as number ?? 0;
  const poses: Pose2D[] = [startPose];

  if (fn === 'drive_forward' || fn === 'drive_backward') {
    const distance = fn === 'drive_backward' ? -arg : arg;
    const steps = Math.max(1, Math.ceil(Math.abs(distance) / stepSize));
    const stepDist = distance / steps;
    let pose = startPose;

    for (let i = 0; i < steps; i++) {
      pose = forwardMove(pose, stepDist);
      poses.push(pose);
    }
  } else if (fn === 'turn_cw' || fn === 'turn_ccw' || fn === 'tank_turn_cw' || fn === 'tank_turn_ccw') {
    // For turns, just add start and end (no intermediate needed for physics)
    poses.push(simulateCommand(startPose, command));
  } else {
    // Other commands - just start and end
    poses.push(simulateCommand(startPose, command));
  }

  return poses;
}
