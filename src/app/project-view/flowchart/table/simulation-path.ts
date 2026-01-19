import { MissionSimulationData, ProjectSimulationData, SimulationStepData } from '../../../entities/Simulation';
import { LineSensor, Pose2D, applyLocalDelta, forwardMove, rotate } from './models';

const EPSILON = 1e-6;
const LABEL_CM_PATTERN = /(?:^|[,(])\s*cm\s*=\s*([-+]?\d*\.?\d+)/i;
const LABEL_FIRST_NUMBER_PATTERN = /\(([-+]?\d*\.?\d+)/;
const DEFAULT_LINEUP_STEP_CM = 0.5;
const DEFAULT_LINEUP_MAX_DISTANCE_CM = 200;
const DEFAULT_LINEUP_ROTATE_STEP_RAD = Math.PI / 90;
const DEFAULT_FOLLOW_LINE_ROTATE_STEP_RAD = Math.PI / 90;
const DEFAULT_FOLLOW_LINE_MAX_DISTANCE_CM = 300;
const FOLLOW_LINE_SAMPLE_COUNT: number = 9;
const FOLLOW_LINE_GAIN_MAX = 0.02;
const FOLLOW_LINE_GAIN_DECAY_MIN_CM = 4;
const FOLLOW_LINE_GAIN_DECAY_SCALE = 0.9;
const FOLLOW_LINE_MAX_TURN_RAD = Math.PI / 60;
const FOLLOW_LINE_WHITE_BIAS = 0.5;
const FOLLOW_LINE_WHITE_DECAY = 0.12;

export interface LineupSimulationContext {
  isOnBlackLine: (xCm: number, yCm: number) => boolean;
  lineSensors: LineSensor[];
  rotationCenterForwardCm: number;
  rotationCenterStrafeCm: number;
  stepCm?: number;
  maxDistanceCm?: number;
  rotateStepRad?: number;
}

export interface PathSimulationOptions {
  lineup?: LineupSimulationContext | null;
}

function parseDistanceCmFromLabel(label?: string): number | null {
  if (!label) return null;
  const cmMatch = label.match(LABEL_CM_PATTERN);
  if (cmMatch) {
    const value = Number.parseFloat(cmMatch[1]);
    return Number.isFinite(value) ? value : null;
  }
  const firstNumberMatch = label.match(LABEL_FIRST_NUMBER_PATTERN);
  if (firstNumberMatch) {
    const value = Number.parseFloat(firstNumberMatch[1]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function normalizeStepDelta(step: SimulationStepData): { forwardCm: number; strafeCm: number } {
  const forwardCm = step.delta.forward * 100;
  const strafeCm = step.delta.strafe * 100;
  const fn = (step.function_name || step.step_type || '').toLowerCase();
  if (!fn) return { forwardCm, strafeCm };

  const labelDistance = parseDistanceCmFromLabel(step.label);
  if (labelDistance === null) return { forwardCm, strafeCm };

  switch (fn) {
    case 'drive_forward':
      return { forwardCm: labelDistance, strafeCm };
    case 'drive_backward':
      return { forwardCm: -labelDistance, strafeCm };
    case 'strafe_left':
      return { forwardCm, strafeCm: -labelDistance };
    case 'strafe_right':
      return { forwardCm, strafeCm: labelDistance };
    default:
      return { forwardCm, strafeCm };
  }
}

function isParallelStep(step: SimulationStepData): boolean {
  const fn = (step.function_name || '').toLowerCase();
  const type = (step.step_type || '').toLowerCase();
  return fn === 'parallel' || type === 'parallel';
}

function flattenSimulationSteps(steps: SimulationStepData[]): SimulationStepData[] {
  const result: SimulationStepData[] = [];
  for (const step of steps) {
    const children = step.children ?? [];
    if (children.length) {
      if (isParallelStep(step)) {
        result.push(step);
      } else {
        result.push(...flattenSimulationSteps(children));
      }
    } else {
      result.push(step);
    }
  }
  return result;
}

export function buildPlannedPathFromSimulation(
  startPose: Pose2D,
  simulation: MissionSimulationData,
  options?: PathSimulationOptions
): Pose2D[] {
  const poses: Pose2D[] = [startPose];
  let current = startPose;

  const steps = flattenSimulationSteps(simulation.steps ?? []);
  for (const step of steps) {
    const fn = (step.function_name || step.step_type || '').toLowerCase();
    if (fn === 'forward_lineup_on_black') {
      const lineupPoses = simulateForwardLineupOnBlack(current, options?.lineup);
      if (lineupPoses.length) {
        poses.push(...lineupPoses);
        current = lineupPoses[lineupPoses.length - 1];
      }
      continue;
    }
    if (fn === 'forward_lineup_on_white') {
      const lineupPoses = simulateForwardLineupOnWhite(current, options?.lineup);
      if (lineupPoses.length) {
        poses.push(...lineupPoses);
        current = lineupPoses[lineupPoses.length - 1];
      }
      continue;
    }
    if (fn === 'backward_lineup_on_black') {
      const lineupPoses = simulateBackwardLineupOnBlack(current, options?.lineup);
      if (lineupPoses.length) {
        poses.push(...lineupPoses);
        current = lineupPoses[lineupPoses.length - 1];
      }
      continue;
    }
    if (fn === 'backward_lineup_on_white') {
      const lineupPoses = simulateBackwardLineupOnWhite(current, options?.lineup);
      if (lineupPoses.length) {
        poses.push(...lineupPoses);
        current = lineupPoses[lineupPoses.length - 1];
      }
      continue;
    }
    if (fn === 'drive_until_black') {
      const drivePoses = simulateDriveUntilColor(current, options?.lineup, 'black');
      if (drivePoses.length) {
        poses.push(...drivePoses);
        current = drivePoses[drivePoses.length - 1];
      }
      continue;
    }
    if (fn === 'drive_until_white') {
      const drivePoses = simulateDriveUntilColor(current, options?.lineup, 'white');
      if (drivePoses.length) {
        poses.push(...drivePoses);
        current = drivePoses[drivePoses.length - 1];
      }
      continue;
    }
    if (fn === 'follow_line') {
      const targetCm = parseDistanceCmFromLabel(step.label) ?? (step.delta?.forward ?? 0) * 100;
      if (options?.lineup) {
        const stopOnIntersection = targetCm <= 0;
        const maxDistance = stopOnIntersection ? DEFAULT_FOLLOW_LINE_MAX_DISTANCE_CM : targetCm;
        if (maxDistance > 0) {
          const followPoses = simulateFollowLine(current, options.lineup, maxDistance, stopOnIntersection);
          if (followPoses.length) {
            poses.push(...followPoses);
            current = followPoses[followPoses.length - 1];
            continue;
          }
        }
      }
    }
    const delta = step.delta;
    if (!delta) continue;

    const { forwardCm, strafeCm } = normalizeStepDelta(step);
    const angular = delta.angular;

    // Simulation uses strafe > 0 = right; pose utils treat strafe > 0 = left.
    const next = applyLocalDelta(current, forwardCm, -strafeCm, angular);

    const moved = Math.abs(forwardCm) > EPSILON || Math.abs(strafeCm) > EPSILON;
    const rotated = Math.abs(angular) > EPSILON;
    current = next;
    if (moved || rotated) {
      poses.push(next);
    }
  }

  return poses;
}

export interface PlannedProjectPath {
  poses: Pose2D[];
  missionEndIndices: number[];
  missionRanges: MissionPlannedRange[];
}

export interface MissionPlannedRange {
  name: string;
  order: number;
  startIndex: number;
  endIndex: number;
}

export function buildPlannedPathFromProjectSimulation(
  startPose: Pose2D,
  simulation: ProjectSimulationData,
  options?: PathSimulationOptions
): PlannedProjectPath {
  const missions = [...(simulation.missions ?? [])].sort((a, b) => a.order - b.order);
  const poses: Pose2D[] = [startPose];
  const missionEndIndices: number[] = [];
  const missionRanges: MissionPlannedRange[] = [];
  let current = startPose;

  for (const mission of missions) {
    const startIndex = poses.length - 1;
    const missionPath = buildPlannedPathFromSimulation(current, mission, options);
    if (missionPath.length > 1) {
      poses.push(...missionPath.slice(1));
    }
    const endIndex = poses.length - 1;
    missionEndIndices.push(endIndex);
    missionRanges.push({
      name: mission.name,
      order: mission.order,
      startIndex,
      endIndex,
    });
    current = missionPath[missionPath.length - 1] ?? current;
  }

  return { poses, missionEndIndices, missionRanges };
}

export function simulateForwardLineupOnBlack(startPose: Pose2D, context?: LineupSimulationContext | null): Pose2D[] {
  if (!context) return [];
  const { lineSensors, rotationCenterForwardCm, rotationCenterStrafeCm } = context;
  if (!lineSensors || lineSensors.length < 2) return [];

  const selected = selectLineupSensors(lineSensors);
  if (!selected) return [];

  const stepCm = context.stepCm ?? DEFAULT_LINEUP_STEP_CM;
  const maxDistance = context.maxDistanceCm ?? DEFAULT_LINEUP_MAX_DISTANCE_CM;
  const rotateStep = context.rotateStepRad ?? DEFAULT_LINEUP_ROTATE_STEP_RAD;
  const path: Pose2D[] = [];
  let pose = startPose;
  let traveled = 0;
  let iterations = 0;
  const maxIterations = Math.ceil(maxDistance / stepCm) + Math.ceil((Math.PI * 4) / rotateStep);

  const isOnBlack = (sensor: LineSensor, checkPose: Pose2D) => {
    const world = sensorWorldPosition(checkPose, sensor, rotationCenterForwardCm, rotationCenterStrafeCm);
    return context.isOnBlackLine(world.x, world.y);
  };

  if (isOnBlack(selected.left, pose)) {
    while (traveled < maxDistance && iterations < maxIterations && isOnBlack(selected.left, pose)) {
      pose = forwardMove(pose, stepCm);
      path.push(pose);
      traveled += stepCm;
      iterations += 1;
    }
  }

  while (traveled < maxDistance && iterations < maxIterations) {
    const leftOnBlack = isOnBlack(selected.left, pose);
    const rightOnBlack = isOnBlack(selected.right, pose);
    if (leftOnBlack && rightOnBlack) {
      break;
    }

    if (leftOnBlack !== rightOnBlack) {
      const direction = leftOnBlack ? 1 : -1;
      pose = rotate(pose, direction * rotateStep);
      path.push(pose);
      iterations += 1;
      continue;
    }

    pose = forwardMove(pose, stepCm);
    path.push(pose);
    traveled += stepCm;
    iterations += 1;
  }

  return path;
}

export function simulateForwardLineupOnWhite(startPose: Pose2D, context?: LineupSimulationContext | null): Pose2D[] {
  if (!context) return [];
  const { lineSensors, rotationCenterForwardCm, rotationCenterStrafeCm } = context;
  if (!lineSensors || lineSensors.length < 2) return [];

  const selected = selectLineupSensors(lineSensors);
  if (!selected) return [];

  const stepCm = context.stepCm ?? DEFAULT_LINEUP_STEP_CM;
  const maxDistance = context.maxDistanceCm ?? DEFAULT_LINEUP_MAX_DISTANCE_CM;
  const rotateStep = context.rotateStepRad ?? DEFAULT_LINEUP_ROTATE_STEP_RAD;
  const path: Pose2D[] = [];
  let pose = startPose;
  let traveled = 0;
  let iterations = 0;
  const maxIterations = Math.ceil(maxDistance / stepCm) + Math.ceil((Math.PI * 4) / rotateStep);

  const isOnBlack = (sensor: LineSensor, checkPose: Pose2D) => {
    const world = sensorWorldPosition(checkPose, sensor, rotationCenterForwardCm, rotationCenterStrafeCm);
    return context.isOnBlackLine(world.x, world.y);
  };

  while (traveled < maxDistance && iterations < maxIterations) {
    const leftOnWhite = !isOnBlack(selected.left, pose);
    const rightOnWhite = !isOnBlack(selected.right, pose);
    if (leftOnWhite && rightOnWhite) {
      break;
    }

    if (leftOnWhite !== rightOnWhite) {
      const direction = leftOnWhite ? 1 : -1;
      pose = rotate(pose, direction * rotateStep);
      path.push(pose);
      iterations += 1;
      continue;
    }

    pose = forwardMove(pose, stepCm);
    path.push(pose);
    traveled += stepCm;
    iterations += 1;
  }

  return path;
}

export function simulateBackwardLineupOnBlack(startPose: Pose2D, context?: LineupSimulationContext | null): Pose2D[] {
  if (!context) return [];
  const { lineSensors, rotationCenterForwardCm, rotationCenterStrafeCm } = context;
  if (!lineSensors || lineSensors.length < 2) return [];

  const selected = selectLineupSensors(lineSensors);
  if (!selected) return [];

  const stepCm = context.stepCm ?? DEFAULT_LINEUP_STEP_CM;
  const maxDistance = context.maxDistanceCm ?? DEFAULT_LINEUP_MAX_DISTANCE_CM;
  const rotateStep = context.rotateStepRad ?? DEFAULT_LINEUP_ROTATE_STEP_RAD;
  const path: Pose2D[] = [];
  let pose = startPose;
  let traveled = 0;
  let iterations = 0;
  const maxIterations = Math.ceil(maxDistance / stepCm) + Math.ceil((Math.PI * 4) / rotateStep);

  const isOnBlack = (sensor: LineSensor, checkPose: Pose2D) => {
    const world = sensorWorldPosition(checkPose, sensor, rotationCenterForwardCm, rotationCenterStrafeCm);
    return context.isOnBlackLine(world.x, world.y);
  };

  if (isOnBlack(selected.left, pose)) {
    while (traveled < maxDistance && iterations < maxIterations && isOnBlack(selected.left, pose)) {
      pose = forwardMove(pose, -stepCm);
      path.push(pose);
      traveled += stepCm;
      iterations += 1;
    }
  }

  while (traveled < maxDistance && iterations < maxIterations) {
    const leftOnBlack = isOnBlack(selected.left, pose);
    const rightOnBlack = isOnBlack(selected.right, pose);
    if (leftOnBlack && rightOnBlack) {
      break;
    }

    if (leftOnBlack !== rightOnBlack) {
      const direction = leftOnBlack ? 1 : -1;
      pose = rotate(pose, direction * rotateStep);
      path.push(pose);
      iterations += 1;
      continue;
    }

    pose = forwardMove(pose, -stepCm);
    path.push(pose);
    traveled += stepCm;
    iterations += 1;
  }

  return path;
}

export function simulateBackwardLineupOnWhite(startPose: Pose2D, context?: LineupSimulationContext | null): Pose2D[] {
  if (!context) return [];
  const { lineSensors, rotationCenterForwardCm, rotationCenterStrafeCm } = context;
  if (!lineSensors || lineSensors.length < 2) return [];

  const selected = selectLineupSensors(lineSensors);
  if (!selected) return [];

  const stepCm = context.stepCm ?? DEFAULT_LINEUP_STEP_CM;
  const maxDistance = context.maxDistanceCm ?? DEFAULT_LINEUP_MAX_DISTANCE_CM;
  const rotateStep = context.rotateStepRad ?? DEFAULT_LINEUP_ROTATE_STEP_RAD;
  const path: Pose2D[] = [];
  let pose = startPose;
  let traveled = 0;
  let iterations = 0;
  const maxIterations = Math.ceil(maxDistance / stepCm) + Math.ceil((Math.PI * 4) / rotateStep);

  const isOnBlack = (sensor: LineSensor, checkPose: Pose2D) => {
    const world = sensorWorldPosition(checkPose, sensor, rotationCenterForwardCm, rotationCenterStrafeCm);
    return context.isOnBlackLine(world.x, world.y);
  };

  while (traveled < maxDistance && iterations < maxIterations) {
    const leftOnWhite = !isOnBlack(selected.left, pose);
    const rightOnWhite = !isOnBlack(selected.right, pose);
    if (leftOnWhite && rightOnWhite) {
      break;
    }

    if (leftOnWhite !== rightOnWhite) {
      const direction = leftOnWhite ? 1 : -1;
      pose = rotate(pose, direction * rotateStep);
      path.push(pose);
      iterations += 1;
      continue;
    }

    pose = forwardMove(pose, -stepCm);
    path.push(pose);
    traveled += stepCm;
    iterations += 1;
  }

  return path;
}

function selectLineupSensors(lineSensors: LineSensor[]): { left: LineSensor; right: LineSensor } | null {
  if (lineSensors.length < 2) return null;
  const sorted = [...lineSensors].sort((a, b) => a.strafeCm - b.strafeCm);
  const right = sorted[0];
  const left = sorted[sorted.length - 1];
  if (!left || !right || left === right) return null;
  return { left, right };
}

export function simulateDriveUntilColor(
  startPose: Pose2D,
  context: LineupSimulationContext | null | undefined,
  target: 'black' | 'white'
): Pose2D[] {
  if (!context) return [];
  const { lineSensors, rotationCenterForwardCm, rotationCenterStrafeCm } = context;
  if (!lineSensors || lineSensors.length === 0) return [];

  const stepCm = context.stepCm ?? DEFAULT_LINEUP_STEP_CM;
  const maxDistance = context.maxDistanceCm ?? DEFAULT_LINEUP_MAX_DISTANCE_CM;
  const path: Pose2D[] = [];
  let pose = startPose;
  let traveled = 0;
  let iterations = 0;
  const maxIterations = Math.ceil(maxDistance / stepCm);

  const isSensorOnTarget = (sensor: LineSensor, checkPose: Pose2D) => {
    const world = sensorWorldPosition(checkPose, sensor, rotationCenterForwardCm, rotationCenterStrafeCm);
    const onBlack = context.isOnBlackLine(world.x, world.y);
    return target === 'black' ? onBlack : !onBlack;
  };

  while (traveled < maxDistance && iterations < maxIterations) {
    const anyOnTarget = lineSensors.some(sensor => isSensorOnTarget(sensor, pose));
    if (anyOnTarget) {
      break;
    }
    pose = forwardMove(pose, stepCm);
    path.push(pose);
    traveled += stepCm;
    iterations += 1;
  }

  return path;
}

function simulateFollowLine(
  startPose: Pose2D,
  context: LineupSimulationContext,
  distanceCm: number,
  stopOnIntersection = false
): Pose2D[] {
  const { lineSensors, rotationCenterForwardCm, rotationCenterStrafeCm } = context;
  if (!lineSensors || lineSensors.length < 2) return [];

  const selected = selectLineupSensors(lineSensors);
  if (!selected) return [];

  const stepCm = context.stepCm ?? DEFAULT_LINEUP_STEP_CM;
  const maxDistance = Math.max(0, distanceCm);
  const rotateStepBase = context.rotateStepRad ?? DEFAULT_LINEUP_ROTATE_STEP_RAD;
  const rotateStep = Math.max(rotateStepBase, DEFAULT_FOLLOW_LINE_ROTATE_STEP_RAD);
  const path: Pose2D[] = [];
  let pose = startPose;
  let traveled = 0;
  let iterations = 0;
  let lastTurnDir = 0;
  let whiteStreak = 0;
  const maxIterations = Math.ceil(maxDistance / stepCm) + 2;

  const isOnBlack = (sensor: LineSensor, checkPose: Pose2D) => {
    const world = sensorWorldPosition(checkPose, sensor, rotationCenterForwardCm, rotationCenterStrafeCm);
    return context.isOnBlackLine(world.x, world.y);
  };

  while (traveled < maxDistance && iterations < maxIterations) {
    const leftOnBlack = isOnBlack(selected.left, pose);
    const rightOnBlack = isOnBlack(selected.right, pose);
    let turn = 0;

    if (stopOnIntersection && leftOnBlack && rightOnBlack) {
      break;
    }

    if (leftOnBlack && rightOnBlack) {
      turn = 0;
      whiteStreak = 0;
    } else if (!leftOnBlack && !rightOnBlack) {
      whiteStreak += 1;
      if (lastTurnDir !== 0) {
        const decay = Math.max(0, 1 - whiteStreak * FOLLOW_LINE_WHITE_DECAY);
        turn = lastTurnDir * rotateStep * FOLLOW_LINE_WHITE_BIAS * decay;
      } else {
        turn = 0;
      }
    } else {
      whiteStreak = 0;
      const lineOffset = estimateLineOffset(pose, context, selected.left, selected.right);
      if (lineOffset !== null) {
        const sensorMid =
          (selected.left.strafeCm + selected.right.strafeCm) * 0.5 - rotationCenterStrafeCm;
        const lineError = lineOffset - sensorMid;
        const absOffset = Math.abs(lineError);
        const sensorSpan = Math.abs(selected.left.strafeCm - selected.right.strafeCm);
        const decay = Math.max(FOLLOW_LINE_GAIN_DECAY_MIN_CM, sensorSpan * FOLLOW_LINE_GAIN_DECAY_SCALE);
        const ratio = absOffset / decay;
        const gain = FOLLOW_LINE_GAIN_MAX * Math.exp(-(ratio * ratio));
        turn = clamp(lineError * gain, -FOLLOW_LINE_MAX_TURN_RAD, FOLLOW_LINE_MAX_TURN_RAD);
      } else {
        turn = leftOnBlack ? rotateStep : -rotateStep;
      }
    }

    if (Math.abs(turn) > 1e-6) {
      lastTurnDir = Math.sign(turn);
    }

    pose = applyLocalDelta(pose, stepCm, 0, turn);
    path.push(pose);
    traveled += stepCm;
    iterations += 1;
  }

  return path;
}

function sensorWorldPosition(
  pose: Pose2D,
  sensor: LineSensor,
  rotationCenterForwardCm: number,
  rotationCenterStrafeCm: number
): { x: number; y: number } {
  const forwardFromRc = sensor.forwardCm - rotationCenterForwardCm;
  const strafeFromRc = sensor.strafeCm - rotationCenterStrafeCm;
  const sensorPose = applyLocalDelta(pose, forwardFromRc, strafeFromRc, 0);
  return { x: sensorPose.x, y: sensorPose.y };
}

function estimateLineOffset(
  pose: Pose2D,
  context: LineupSimulationContext,
  left: LineSensor,
  right: LineSensor
): number | null {
  const forwardOffset = (left.forwardCm + right.forwardCm) * 0.5 - context.rotationCenterForwardCm;
  const leftStrafe = left.strafeCm - context.rotationCenterStrafeCm;
  const rightStrafe = right.strafeCm - context.rotationCenterStrafeCm;
  const start = Math.min(leftStrafe, rightStrafe);
  const end = Math.max(leftStrafe, rightStrafe);
  const samples = FOLLOW_LINE_SAMPLE_COUNT;
  const blackSamples: number[] = [];

  for (let i = 0; i < samples; i++) {
    const t = samples === 1 ? 0.5 : i / (samples - 1);
    const strafe = start + (end - start) * t;
    const samplePose = applyLocalDelta(pose, forwardOffset, strafe, 0);
    if (context.isOnBlackLine(samplePose.x, samplePose.y)) {
      blackSamples.push(strafe);
    }
  }

  if (!blackSamples.length) return null;
  const avg = blackSamples.reduce((sum, value) => sum + value, 0) / blackSamples.length;
  return avg;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
