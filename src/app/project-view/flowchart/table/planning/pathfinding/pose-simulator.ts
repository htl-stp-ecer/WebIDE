import { Pose2D, forwardMove, rotate } from '../../models';
import { MissionStep } from '../../../../../entities/MissionStep';
import {
  isBackwardStepId,
  isClockwiseStepId,
  isCounterClockwiseStepId,
  isDriveStepId,
  isLeftStepId,
  isStrafeStepId,
  isTurnStepId,
  stepId,
} from '../../step-id';

/**
 * Simulate the resulting pose from executing a command.
 * This is a lightweight computation without backend calls.
 */
export function simulateCommand(startPose: Pose2D, command: MissionStep): Pose2D {
  const fn = stepId(command);
  const arg = command.arguments[0]?.value as number ?? 0;

  if (isDriveStepId(fn)) {
    return forwardMove(startPose, isBackwardStepId(fn) ? -arg : arg);
  }

  if (isTurnStepId(fn)) {
    // Prefer explicit turn direction tokens; if missing, use argument sign.
    const positiveDegrees = Math.abs(arg);
    const signedDegrees = isClockwiseStepId(fn)
      ? -positiveDegrees
      : isCounterClockwiseStepId(fn)
        ? positiveDegrees
        : arg;
    return rotate(startPose, signedDegrees * Math.PI / 180);
  }

  if (isStrafeStepId(fn)) {
    // Strafe perpendicular to heading (left = positive perpendicular).
    return strafeMove(startPose, isLeftStepId(fn) ? arg : -arg);
  }

  // Unknown command - return unchanged pose
  return { ...startPose };
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
  const fn = stepId(command);
  const arg = command.arguments[0]?.value as number ?? 0;
  const poses: Pose2D[] = [startPose];

  if (isDriveStepId(fn)) {
    const distance = isBackwardStepId(fn) ? -arg : arg;
    const steps = Math.max(1, Math.ceil(Math.abs(distance) / stepSize));
    const stepDist = distance / steps;
    let pose = startPose;

    for (let i = 0; i < steps; i++) {
      pose = forwardMove(pose, stepDist);
      poses.push(pose);
    }
  } else if (isTurnStepId(fn)) {
    // For turns, just add start and end (no intermediate needed for physics)
    poses.push(simulateCommand(startPose, command));
  } else {
    // Other commands - just start and end
    poses.push(simulateCommand(startPose, command));
  }

  return poses;
}
