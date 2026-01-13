import { MissionSimulationData, ProjectSimulationData, SimulationStepData } from '../../../entities/Simulation';
import { LineSensor, Pose2D, applyLocalDelta, forwardMove, rotate } from './models';

const EPSILON = 1e-6;
const LABEL_CM_PATTERN = /(?:^|[,(])\s*cm\s*=\s*([-+]?\d*\.?\d+)/i;
const LABEL_FIRST_NUMBER_PATTERN = /\(([-+]?\d*\.?\d+)/;
const DEFAULT_LINEUP_STEP_CM = 0.5;
const DEFAULT_LINEUP_MAX_DISTANCE_CM = 200;
const DEFAULT_LINEUP_ROTATE_STEP_RAD = Math.PI / 90;

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

function simulateForwardLineupOnBlack(startPose: Pose2D, context?: LineupSimulationContext | null): Pose2D[] {
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

function simulateForwardLineupOnWhite(startPose: Pose2D, context?: LineupSimulationContext | null): Pose2D[] {
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

  while (traveled < maxDistance && iterations < maxIterations && !isOnBlack(selected.left, pose)) {
    pose = forwardMove(pose, stepCm);
    path.push(pose);
    traveled += stepCm;
    iterations += 1;
  }

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

function simulateBackwardLineupOnBlack(startPose: Pose2D, context?: LineupSimulationContext | null): Pose2D[] {
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

function selectLineupSensors(lineSensors: LineSensor[]): { left: LineSensor; right: LineSensor } | null {
  if (lineSensors.length < 2) return null;
  const sorted = [...lineSensors].sort((a, b) => a.strafeCm - b.strafeCm);
  const right = sorted[0];
  const left = sorted[sorted.length - 1];
  if (!left || !right || left === right) return null;
  return { left, right };
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
