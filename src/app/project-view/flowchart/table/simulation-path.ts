import { MissionSimulationData, ProjectSimulationData, SimulationStepData } from '../../../entities/Simulation';
import { Pose2D, applyLocalDelta } from './models';

const EPSILON = 1e-6;
const LABEL_CM_PATTERN = /(?:^|[,(])\s*cm\s*=\s*([-+]?\d*\.?\d+)/i;
const LABEL_FIRST_NUMBER_PATTERN = /\(([-+]?\d*\.?\d+)/;

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
  simulation: MissionSimulationData
): Pose2D[] {
  const poses: Pose2D[] = [startPose];
  let current = startPose;

  const steps = flattenSimulationSteps(simulation.steps ?? []);
  for (const step of steps) {
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
}

export function buildPlannedPathFromProjectSimulation(
  startPose: Pose2D,
  simulation: ProjectSimulationData
): PlannedProjectPath {
  const missions = [...(simulation.missions ?? [])].sort((a, b) => a.order - b.order);
  const poses: Pose2D[] = [startPose];
  const missionEndIndices: number[] = [];
  let current = startPose;

  for (const mission of missions) {
    const missionPath = buildPlannedPathFromSimulation(current, mission);
    if (missionPath.length > 1) {
      poses.push(...missionPath.slice(1));
      missionEndIndices.push(poses.length - 1);
    }
    current = missionPath[missionPath.length - 1] ?? current;
  }

  return { poses, missionEndIndices };
}
