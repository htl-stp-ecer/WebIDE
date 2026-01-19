/// <reference lib="webworker" />

import { MissionStep } from '../../../../../entities/MissionStep';
import { Pose2D, applyLocalDelta, normalizeAngle, type LineSensor } from '../../models';
import { MapConfig, RobotConfig, type LineSegmentCm } from '../../services';
import { WallSegment, checkPathCollision, checkRobotCollision, isRobotInBounds } from '../../physics';
import { findPath, optimizePath, type AStarConfig } from './astar-commands';
import { simulateCommand, simulateCommands } from './pose-simulator';
import {
  closestLineNormalAngle,
  findClosestLineSegment,
  linePerpendicularScore,
  lineupPerpThreshold,
  lineupProximityCm,
} from '../line-utils';
import {
  LineupSimulationContext,
  simulateBackwardLineupOnBlack,
  simulateBackwardLineupOnWhite,
  simulateDriveUntilColor,
  simulateForwardLineupOnBlack,
  simulateForwardLineupOnWhite,
} from '../../simulation-path';
import { optimizeWaypointsToSteps, type OptimizationContext } from '../path-optimizer';
import { buildAdStarGrid, findAdStarPath } from './adstar-grid';

interface AStarWorkerRequest {
  id: number;
  startPose: Pose2D;
  waypoints: { x: number; y: number }[];
  walls: WallSegment[];
  robotConfig: RobotConfig;
  mapConfig: MapConfig;
  config: AStarConfig;
  tightConfig?: AStarConfig;
  lineSegments?: LineSegmentCm[];
  lineupThreshold?: number;
  lineSensorCount?: number;
  lineSensors?: LineSensor[];
  rotationCenterForwardCm?: number;
  rotationCenterStrafeCm?: number;
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
  let grid = null as ReturnType<typeof buildAdStarGrid> | null;

  for (const waypoint of request.waypoints) {
    const direct = generateDirectSteps(currentPose, waypoint);
    const directPose = validateCommands(currentPose, direct.steps, request);
    if (directPose) {
      const lineAware = generateLineAwareDirectSteps(currentPose, waypoint, request);
      steps.push(...lineAware.steps);
      currentPose = lineAware.finalPose;
      continue;
    }

    if (!grid) {
      grid = buildAdStarGrid(
        request.walls,
        request.mapConfig,
        request.robotConfig,
        getAdStarNodeSize(request)
      );
    }
    const adStarResult = generateAdStarSteps(currentPose, waypoint, request, grid);
    if (adStarResult) {
      steps.push(...adStarResult.steps);
      currentPose = adStarResult.finalPose;
      continue;
    }

    const result = findValidatedAStarPath(currentPose, waypoint, request);
    if (result) {
      const adjusted = applyLineAdjustments(result.commands, currentPose, result.finalPose, request);
      steps.push(...adjusted.commands);
      currentPose = adjusted.finalPose;
      continue;
    }

    const fallback = generateDirectSteps(currentPose, waypoint);
    const adjustedFallback = applyLineAdjustments(fallback.steps, currentPose, fallback.finalPose, request);
    steps.push(...adjustedFallback.commands);
    currentPose = adjustedFallback.finalPose;
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

function generateLineAwareDirectSteps(
  startPose: Pose2D,
  goal: { x: number; y: number },
  request: AStarWorkerRequest
): { steps: MissionStep[]; finalPose: Pose2D } {
  const lineSegments = request.lineSegments ?? [];
  const lineupThreshold = request.lineupThreshold ?? 0.5;
  const detectDistance = getLineDetectDistance(request);
  const context = buildOptimizationContextForRequest(request, lineSegments, detectDistance);

  const waypoints = [
    { id: 'start', x: startPose.x, y: startPose.y },
    { id: 'goal', x: goal.x, y: goal.y },
  ];

  const steps = optimizeWaypointsToSteps(waypoints, startPose, context, { lineupThreshold });
  const lineupContext = buildLineupContext(request, lineSegments, detectDistance);
  const finalPose = lineupContext
    ? simulateCommandsWithLineups(steps, startPose, lineupContext)
    : simulateCommands(startPose, steps);

  return { steps, finalPose };
}

function generateAdStarSteps(
  startPose: Pose2D,
  goal: { x: number; y: number },
  request: AStarWorkerRequest,
  grid: ReturnType<typeof buildAdStarGrid>
): { steps: MissionStep[]; finalPose: Pose2D } | null {
  const path = findAdStarPath(startPose, goal, grid);
  if (!path || path.points.length < 2) return null;

  const lineSegments = request.lineSegments ?? [];
  const lineupThreshold = request.lineupThreshold ?? 0.5;
  const detectDistance = getLineDetectDistance(request);
  const context = buildOptimizationContextForRequest(request, lineSegments, detectDistance);

  const waypoints = path.points.map((point, index) => ({
    id: `adstar-${index}`,
    x: point.x,
    y: point.y,
  }));

  const baseContext: OptimizationContext = {
    ...context,
    sensorConfig: { lineSensors: [] },
  };
  const baseSteps = optimizeWaypointsToSteps(waypoints, startPose, baseContext, { lineupThreshold });
  const validatedPose = validateCommands(startPose, baseSteps, request);
  if (!validatedPose) return null;

  const steps = optimizeWaypointsToSteps(waypoints, startPose, context, { lineupThreshold });

  const lineupContext = buildLineupContext(request, lineSegments, detectDistance);
  const finalPose = lineupContext
    ? simulateCommandsWithLineups(steps, startPose, lineupContext)
    : simulateCommands(startPose, steps);

  return { steps, finalPose };
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

function applyLineAdjustments(
  commands: MissionStep[],
  startPose: Pose2D,
  finalPose: Pose2D,
  request: AStarWorkerRequest
): { commands: MissionStep[]; finalPose: Pose2D } {
  const lineSegments = request.lineSegments ?? [];
  const sensorCount = request.lineSensorCount ?? 0;
  if (!lineSegments.length || sensorCount < 1) {
    return { commands, finalPose };
  }

  const lineupThreshold = request.lineupThreshold ?? 0.5;
  const lineProximity = lineupProximityCm(lineupThreshold);
  const perpThreshold = lineupPerpThreshold(lineupThreshold);
  const lineupContext = buildLineupContext(request, lineSegments, getLineDetectDistance(request));
  if (!lineupContext) {
    return { commands, finalPose };
  }

  const driveContext = findLastDriveContext(commands, startPose);
  if (!driveContext) {
    return { commands, finalPose };
  }

  const lineInfo = findClosestLineSegment(lineSegments, driveContext.endPose.x, driveContext.endPose.y);
  if (!lineInfo || lineInfo.distance > lineProximity) {
    return { commands, finalPose };
  }

  const perpScore = linePerpendicularScore(driveContext.endPose.theta, lineInfo.angle);
  if (perpScore < perpThreshold) {
    return { commands, finalPose };
  }

  const updated = [...commands];
  let lineupAdded = false;
  const startOnLine = isAnySensorOnLine(driveContext.startPose, lineupContext);
  const canLineup = sensorCount >= 2;
  if (
    !canLineup &&
    sensorCount >= 1 &&
    driveContext.command.function_name === 'drive_forward' &&
    !startOnLine
  ) {
    updated[driveContext.index] = createDriveUntilStep('black');
  }

  if (canLineup) {
    const direction = driveContext.command.function_name === 'drive_backward' ? 'backward' : 'forward';
    updated.push(createLineupStep(direction, 'black'));
    lineupAdded = true;
  }

  const simulatedPose = simulateCommandsWithLineups(updated, startPose, lineupContext);
  const adjustedPose = lineupAdded
    ? { ...simulatedPose, theta: closestLineNormalAngle(simulatedPose.theta, lineInfo.angle) }
    : simulatedPose;
  return { commands: updated, finalPose: adjustedPose };
}

function buildOptimizationContextForRequest(
  request: AStarWorkerRequest,
  lineSegments: LineSegmentCm[],
  detectDistanceCm: number
): OptimizationContext {
  return {
    lineSegments,
    sensorConfig: { lineSensors: request.lineSensors ?? [] },
    isOnBlackLine: (x, y) => isPointOnLine(x, y, lineSegments, detectDistanceCm),
    rotationCenterForwardCm: request.rotationCenterForwardCm ?? 0,
    rotationCenterStrafeCm: request.rotationCenterStrafeCm ?? 0,
    maxLineupDistanceCm: Math.max(request.mapConfig.widthCm, request.mapConfig.heightCm),
  };
}

function getLineDetectDistance(request: AStarWorkerRequest): number {
  const lineupThreshold = request.lineupThreshold ?? 0.5;
  const lineProximity = lineupProximityCm(lineupThreshold);
  return Math.max(1.5, lineProximity * 0.5);
}

function getAdStarNodeSize(request: AStarWorkerRequest): number {
  const base = request.config?.positionResolutionCm ?? 5;
  return Math.max(2, Math.round(base));
}

function findLastDriveContext(
  commands: MissionStep[],
  startPose: Pose2D
): { index: number; command: MissionStep; startPose: Pose2D; endPose: Pose2D } | null {
  let pose = startPose;
  let lastIndex = -1;
  let lastCommand: MissionStep | null = null;
  let lastStartPose = startPose;
  let lastEndPose = startPose;

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    const fn = command.function_name;
    const isDrive = fn === 'drive_forward' || fn === 'drive_backward';
    if (isDrive) {
      lastIndex = i;
      lastCommand = command;
      lastStartPose = pose;
    }
    pose = simulateCommand(pose, command);
    if (isDrive) {
      lastEndPose = pose;
    }
  }

  if (lastIndex < 0 || !lastCommand) {
    return null;
  }

  return { index: lastIndex, command: lastCommand, startPose: lastStartPose, endPose: lastEndPose };
}

function buildLineupContext(
  request: AStarWorkerRequest,
  lineSegments: LineSegmentCm[],
  detectDistanceCm: number
): LineupSimulationContext | null {
  const sensors = request.lineSensors ?? [];
  if (!sensors.length) return null;

  return {
    isOnBlackLine: (x, y) => isPointOnLine(x, y, lineSegments, detectDistanceCm),
    lineSensors: sensors,
    rotationCenterForwardCm: request.rotationCenterForwardCm ?? 0,
    rotationCenterStrafeCm: request.rotationCenterStrafeCm ?? 0,
    maxDistanceCm: Math.max(request.mapConfig.widthCm, request.mapConfig.heightCm),
  };
}

function isPointOnLine(
  x: number,
  y: number,
  lineSegments: LineSegmentCm[],
  detectDistanceCm: number
): boolean {
  const info = findClosestLineSegment(lineSegments, x, y);
  return !!info && info.distance <= detectDistanceCm;
}

function isAnySensorOnLine(pose: Pose2D, context: LineupSimulationContext): boolean {
  for (const sensor of context.lineSensors) {
    const forwardFromRc = sensor.forwardCm - context.rotationCenterForwardCm;
    const strafeFromRc = sensor.strafeCm - context.rotationCenterStrafeCm;
    const sensorPose = applyLocalDelta(pose, forwardFromRc, strafeFromRc, 0);
    if (context.isOnBlackLine(sensorPose.x, sensorPose.y)) {
      return true;
    }
  }
  return false;
}

function simulateCommandsWithLineups(
  commands: MissionStep[],
  startPose: Pose2D,
  context: LineupSimulationContext
): Pose2D {
  let pose = startPose;
  for (const command of commands) {
    const fn = command.function_name;
    if (fn === 'drive_until_black') {
      const poses = simulateDriveUntilColor(pose, context, 'black');
      if (poses.length) {
        pose = poses[poses.length - 1];
      }
      continue;
    }
    if (fn === 'drive_until_white') {
      const poses = simulateDriveUntilColor(pose, context, 'white');
      if (poses.length) {
        pose = poses[poses.length - 1];
      }
      continue;
    }
    if (fn === 'forward_lineup_on_black') {
      const poses = simulateForwardLineupOnBlack(pose, context);
      if (poses.length) {
        pose = poses[poses.length - 1];
      }
      continue;
    }
    if (fn === 'forward_lineup_on_white') {
      const poses = simulateForwardLineupOnWhite(pose, context);
      if (poses.length) {
        pose = poses[poses.length - 1];
      }
      continue;
    }
    if (fn === 'backward_lineup_on_black') {
      const poses = simulateBackwardLineupOnBlack(pose, context);
      if (poses.length) {
        pose = poses[poses.length - 1];
      }
      continue;
    }
    if (fn === 'backward_lineup_on_white') {
      const poses = simulateBackwardLineupOnWhite(pose, context);
      if (poses.length) {
        pose = poses[poses.length - 1];
      }
      continue;
    }

    pose = simulateCommand(pose, command);
  }

  return pose;
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
