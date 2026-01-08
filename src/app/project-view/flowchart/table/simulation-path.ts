import { MissionSimulationData, SimulationStepData } from '../../../entities/Simulation';
import { Pose2D, applyLocalDelta } from './models';

const EPSILON = 1e-6;

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

    const forwardCm = delta.forward * 100;
    const strafeCm = delta.strafe * 100;
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
