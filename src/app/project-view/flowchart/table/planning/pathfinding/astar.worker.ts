/// <reference lib="webworker" />

import { MissionStep } from '../../../../../entities/MissionStep';
import { Pose2D, normalizeAngle } from '../../models';
import { MapConfig, RobotConfig } from '../../services';
import { WallSegment, checkPathCollision, checkRobotCollision, isRobotInBounds } from '../../physics';
import { findPath, optimizePath, type AStarConfig } from './astar-commands';
import { simulateCommand } from './pose-simulator';

interface AStarWorkerRequest {
  id: number;
  startPose: Pose2D;
  waypoints: { x: number; y: number }[];
  walls: WallSegment[];
  robotConfig: RobotConfig;
  mapConfig: MapConfig;
  config: AStarConfig;
  tightConfig?: AStarConfig;
}

interface AStarWorkerResponse {
  id: number;
  steps: MissionStep[];
}

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<AStarWorkerRequest>) => {
  const request = event.data;
  if (!request.waypoints.length) {
    const emptyResponse: AStarWorkerResponse = { id: request.id, steps: [] };
    ctx.postMessage(emptyResponse);
    return;
  }

  const steps = generateSteps(request);
  const response: AStarWorkerResponse = { id: request.id, steps };
  ctx.postMessage(response);
});

function generateSteps(request: AStarWorkerRequest): MissionStep[] {
  let currentPose = request.startPose;
  const steps: MissionStep[] = [];

  for (const waypoint of request.waypoints) {
    const result = findValidatedAStarPath(currentPose, waypoint, request);
    if (result) {
      steps.push(...result.commands);
      currentPose = result.finalPose;
      continue;
    }

    const fallback = generateDirectSteps(currentPose, waypoint);
    steps.push(...fallback.steps);
    currentPose = fallback.finalPose;
  }

  return steps;
}

function findValidatedAStarPath(
  startPose: Pose2D,
  goal: { x: number; y: number },
  request: AStarWorkerRequest
): { commands: MissionStep[]; finalPose: Pose2D } | null {
  const configs: AStarConfig[] = request.tightConfig
    ? [request.config, request.tightConfig]
    : [request.config];

  for (const config of configs) {
    const result = findPath(startPose, goal, request.walls, request.robotConfig, request.mapConfig, config);
    if (!result) continue;
    const optimized = optimizePath(result);
    const validated = validateCommands(startPose, optimized.commands, request);
    if (!validated) continue;
    return { commands: optimized.commands, finalPose: validated };
  }

  return null;
}

function validateCommands(
  startPose: Pose2D,
  commands: MissionStep[],
  request: AStarWorkerRequest
): Pose2D | null {
  let pose = startPose;
  for (const command of commands) {
    const fn = command.function_name;
    const arg = (command.arguments[0]?.value as number) ?? 0;
    const nextPose = simulateCommand(pose, command);

    if (!isRobotInBounds(nextPose, request.mapConfig, request.robotConfig)) return null;

    const isTurn = fn === 'turn_cw' || fn === 'turn_ccw' || fn === 'tank_turn_cw' || fn === 'tank_turn_ccw';
    if (isTurn) {
      const angleSteps = Math.max(6, Math.ceil(Math.abs(arg) / 5));
      if (checkRotationCollision(pose, nextPose, request.robotConfig, request.walls, angleSteps)) {
        return null;
      }
    } else if (fn === 'drive_forward' || fn === 'drive_backward') {
      const steps = Math.max(5, Math.ceil(Math.abs(arg) / 2));
      const startCollides = checkRobotCollision(pose, request.robotConfig, request.walls);
      const blocked = startCollides
        ? checkPathCollisionExcludingStart(pose, nextPose, request.robotConfig, request.walls, steps)
        : checkPathCollision(pose, nextPose, request.robotConfig, request.walls, steps);
      if (blocked) return null;
    }

    pose = nextPose;
  }

  return pose;
}

function generateDirectSteps(
  startPose: Pose2D,
  goal: { x: number; y: number }
): { steps: MissionStep[]; finalPose: Pose2D } {
  const dx = goal.x - startPose.x;
  const dy = goal.y - startPose.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance < 0.1) {
    return { steps: [], finalPose: startPose };
  }

  const targetHeading = Math.atan2(dy, dx);
  const angleDiff = normalizeAngle(targetHeading - startPose.theta);
  const angleDeg = angleDiff * (180 / Math.PI);
  const steps: MissionStep[] = [];
  let pose = startPose;

  const roundedAngle = Math.round(angleDeg);
  if (Math.abs(roundedAngle) >= 1) {
    const turnStep = createTurnStep(roundedAngle);
    steps.push(turnStep);
    pose = simulateCommand(pose, turnStep);
  }

  const roundedDistance = Math.round(distance);
  if (roundedDistance > 1) {
    const driveStep = createDriveStep(roundedDistance);
    steps.push(driveStep);
    pose = simulateCommand(pose, driveStep);
  }

  return { steps, finalPose: pose };
}

function createTurnStep(angleDeg: number): MissionStep {
  const isClockwise = angleDeg < 0;
  return {
    step_type: '',
    function_name: isClockwise ? 'turn_cw' : 'turn_ccw',
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

function checkPathCollisionExcludingStart(
  startPose: Pose2D,
  endPose: Pose2D,
  robotConfig: RobotConfig,
  walls: WallSegment[],
  steps: number
): boolean {
  if (checkRobotCollision(endPose, robotConfig, walls)) return true;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const intermediatePose: Pose2D = {
      x: startPose.x + (endPose.x - startPose.x) * t,
      y: startPose.y + (endPose.y - startPose.y) * t,
      theta: startPose.theta + (endPose.theta - startPose.theta) * t,
    };
    if (checkRobotCollision(intermediatePose, robotConfig, walls)) {
      return true;
    }
  }

  return false;
}

function checkRotationCollision(
  startPose: Pose2D,
  endPose: Pose2D,
  robotConfig: RobotConfig,
  walls: WallSegment[],
  steps: number
): boolean {
  const delta = normalizeAngle(endPose.theta - startPose.theta);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const pose: Pose2D = {
      x: startPose.x,
      y: startPose.y,
      theta: normalizeAngle(startPose.theta + delta * t),
    };
    if (checkRobotCollision(pose, robotConfig, walls)) {
      return true;
    }
  }
  return false;
}
