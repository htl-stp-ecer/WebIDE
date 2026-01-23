/// <reference lib="webworker" />

import { MissionStep } from '../../../../../entities/MissionStep';
import { Pose2D, applyLocalDelta, forwardMove, normalizeAngle, type LineSensor } from '../../models';
import { MapConfig, RobotConfig, type LineSegmentCm } from '../../services';
import { WallSegment, checkPathCollision, checkRobotCollision, isRobotInBounds } from '../../physics';
import { findPath, optimizePath, type AStarConfig } from './astar-commands';
import { simulateCommand, simulateCommands } from './pose-simulator';
import {
  findClosestLineSegment,
  lineupProximityCm,
} from '../line-utils';
import {
  LineupSimulationContext,
  simulateBackwardLineupOnBlack,
  simulateBackwardLineupOnWhite,
  simulateDriveUntilColor,
  simulateFollowLine,
  simulateForwardLineupOnBlack,
  simulateForwardLineupOnWhite,
} from '../../simulation-path';
import { optimizeWaypointsToSteps, type OptimizationContext } from '../path-optimizer';
import { buildAdStarGrid, findAdStarPath } from './adstar-grid';

interface AStarWorkerRequest {
  id: number;
  startPose: Pose2D;
  waypoints: { x: number; y: number; lineup?: boolean; lineupLineIndex?: number }[];
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
  allowStrafe?: boolean;
}

interface AStarWorkerResponse {
  id: number;
  steps: MissionStep[];
}

const TURN_CLEARANCE_CM = 1;

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
  let previousWaypoint: AStarWorkerRequest['waypoints'][number] | null = null;

  for (const waypoint of request.waypoints) {
    if (previousWaypoint && shouldFollowLineSegment(previousWaypoint, waypoint)) {
      const lineIndex = previousWaypoint.lineupLineIndex as number;
      const followResult = generateFollowLineSteps(currentPose, waypoint, lineIndex, request);
      steps.push(...followResult.steps);
      currentPose = followResult.finalPose;
      previousWaypoint = waypoint;
      continue;
    }

    const segmentStartPose = currentPose;
    const direct = generateDirectSteps(currentPose, waypoint);
    const directPose = validateCommands(currentPose, direct.steps, request);
    if (directPose) {
      const lineAware = generateLineAwareDirectSteps(currentPose, waypoint, request);
      steps.push(...lineAware.steps);
      currentPose = lineAware.finalPose;
      currentPose = appendLineupForWaypoint(
        steps,
        lineAware.steps,
        segmentStartPose,
        currentPose,
        waypoint,
        request
      );
      previousWaypoint = waypoint;
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
      currentPose = appendLineupForWaypoint(
        steps,
        adStarResult.steps,
        segmentStartPose,
        currentPose,
        waypoint,
        request
      );
      previousWaypoint = waypoint;
      continue;
    }

    const result = findValidatedAStarPath(currentPose, waypoint, request);
    if (result) {
      steps.push(...result.commands);
      currentPose = result.finalPose;
      currentPose = appendLineupForWaypoint(
        steps,
        result.commands,
        segmentStartPose,
        currentPose,
        waypoint,
        request
      );
      previousWaypoint = waypoint;
      continue;
    }

    const fallback = generateDirectSteps(currentPose, waypoint);
    steps.push(...fallback.steps);
    currentPose = fallback.finalPose;
    currentPose = appendLineupForWaypoint(
      steps,
      fallback.steps,
      segmentStartPose,
      currentPose,
      waypoint,
      request
    );
    previousWaypoint = waypoint;
  }

  return steps;
}

function appendLineupForWaypoint(
  steps: MissionStep[],
  segmentSteps: MissionStep[],
  segmentStartPose: Pose2D,
  currentPose: Pose2D,
  waypoint: { lineup?: boolean; lineupLineIndex?: number },
  request: AStarWorkerRequest
): Pose2D {
  if (!waypoint.lineup) return currentPose;
  if (segmentSteps.some(step => step.function_name.includes('lineup'))) return currentPose;

  const lastDrive = getLastDriveInfo(segmentSteps);
  let lineupStartPose = currentPose;
  let direction: 'forward' | 'backward' = 'forward';
  if (lastDrive) {
    const baseIndex = steps.length - segmentSteps.length;
    steps.splice(baseIndex + lastDrive.index);

    lineupStartPose = simulateCommands(segmentStartPose, segmentSteps.slice(0, lastDrive.index));
    direction = lastDrive.direction;

    const approachOffset = getLineupApproachOffset(request, direction);
    let trimmedDistance = Math.max(0, Math.round(lastDrive.distanceCm - approachOffset));

    const lineSegments = request.lineSegments ?? [];
    const segmentEndPose = simulateCommand(lineupStartPose, segmentSteps[lastDrive.index]);
    const blockingDistance = typeof waypoint.lineupLineIndex === 'number'
      ? findLastBlockingDistanceOnSegment(
        lineupStartPose,
        segmentEndPose,
        lineSegments,
        waypoint.lineupLineIndex
      )
      : null;
    if (blockingDistance !== null) {
      trimmedDistance = Math.max(trimmedDistance, Math.round(blockingDistance + 1));
    }

    const targetLine = typeof waypoint.lineupLineIndex === 'number'
      ? lineSegments[waypoint.lineupLineIndex]
      : null;
    const targetDistance = targetLine
      ? segmentIntersectionDistance(
        lineupStartPose.x,
        lineupStartPose.y,
        segmentEndPose.x,
        segmentEndPose.y,
        targetLine.startX,
        targetLine.startY,
        targetLine.endX,
        targetLine.endY
      ) ?? lastDrive.distanceCm
      : lastDrive.distanceCm;
    const maxBeforeTarget = Math.max(0, Math.round(targetDistance - 0.5));
    trimmedDistance = Math.min(trimmedDistance, maxBeforeTarget);

    const detectDistance = getLineDetectDistance(request);
    const lineupContext = targetLine
      ? buildLineupContextForLine(request, targetLine, detectDistance)
      : buildLineupContext(request, lineSegments, detectDistance);

    const contactDistance = lineupContext
      ? findFirstLineContactDistance(lineupStartPose, targetDistance, direction, lineupContext)
      : null;
    if (contactDistance !== null) {
      trimmedDistance = Math.min(trimmedDistance, Math.max(0, Math.round(contactDistance - 1)));
    }

    if (trimmedDistance > 0 && lineupContext) {
      let adjusted = trimmedDistance;
      let guard = 0;
      while (adjusted > 0 && guard < 300) {
        const pose = simulateCommand(lineupStartPose, cloneDriveStep(segmentSteps[lastDrive.index], adjusted));
        if (!isAnySensorOnLine(pose, lineupContext)) {
          break;
        }
        adjusted = Math.max(0, adjusted - 1);
        guard += 1;
      }
      trimmedDistance = adjusted;
    }

    if (trimmedDistance > 0) {
      const trimmedStep = cloneDriveStep(segmentSteps[lastDrive.index], trimmedDistance);
      steps.push(trimmedStep);
      lineupStartPose = simulateCommand(lineupStartPose, trimmedStep);
    }
  }

  steps.push(createLineupStep(direction, 'black'));

  const finalLineSegments = request.lineSegments ?? [];
  const finalDetectDistance = getLineDetectDistance(request);
  const finalTargetLine = typeof waypoint.lineupLineIndex === 'number'
    ? finalLineSegments[waypoint.lineupLineIndex]
    : null;
  const finalLineupContext = finalTargetLine
    ? buildLineupContextForLine(request, finalTargetLine, finalDetectDistance)
    : buildLineupContext(request, finalLineSegments, finalDetectDistance);
  const lineupContext = finalLineupContext;
  if (!lineupContext) return lineupStartPose;

  const lineupPoses =
    direction === 'backward'
      ? simulateBackwardLineupOnBlack(lineupStartPose, lineupContext)
      : simulateForwardLineupOnBlack(lineupStartPose, lineupContext);
  if (lineupPoses.length) {
    return lineupPoses[lineupPoses.length - 1];
  }

  return lineupStartPose;
}

function getLastDriveInfo(
  steps: MissionStep[]
): { index: number; direction: 'forward' | 'backward'; distanceCm: number } | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const fn = steps[i].function_name;
    if (fn === 'drive_backward' || fn === 'drive_forward') {
      const distance = (steps[i].arguments[0]?.value as number) ?? 0;
      return { index: i, direction: fn === 'drive_backward' ? 'backward' : 'forward', distanceCm: distance };
    }
  }
  return null;
}

function cloneDriveStep(step: MissionStep, distanceCm: number): MissionStep {
  return {
    ...step,
    arguments: [{ name: 'cm', value: distanceCm, type: 'float' }],
  };
}

function getLineupApproachOffset(
  request: AStarWorkerRequest,
  direction: 'forward' | 'backward'
): number {
  const sensors = request.lineSensors ?? [];
  if (!sensors.length) return 2;

  const rotationCenterForward = request.rotationCenterForwardCm ?? 0;
  let maxProjection = Number.NEGATIVE_INFINITY;
  const sign = direction === 'forward' ? 1 : -1;

  for (const sensor of sensors) {
    const forwardFromRc = sensor.forwardCm - rotationCenterForward;
    const projection = forwardFromRc * sign;
    if (projection > maxProjection) maxProjection = projection;
  }

  const offset = Math.max(0, maxProjection);
  return Math.max(3, offset + 2);
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
    const result = findPath(
      startPose,
      goal,
      request.walls,
      request.robotConfig,
      request.mapConfig,
      config,
      { allowStrafe: request.allowStrafe ?? true }
    );
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
  const rotationConfig = inflateRobotConfig(request.robotConfig, TURN_CLEARANCE_CM);
  for (const command of commands) {
    const fn = command.function_name;
    const arg = (command.arguments[0]?.value as number) ?? 0;
    const nextPose = simulateCommand(pose, command);

    if (!isRobotInBounds(nextPose, request.mapConfig, request.robotConfig)) return null;

    const isTurn = fn === 'turn_cw' || fn === 'turn_ccw' || fn === 'tank_turn_cw' || fn === 'tank_turn_ccw';
    const isDrive =
      fn === 'drive_forward' ||
      fn === 'drive_backward' ||
      fn === 'strafe_left' ||
      fn === 'strafe_right';
    if (isTurn) {
      const angleSteps = Math.max(6, Math.ceil(Math.abs(arg) / 5));
      if (checkRotationCollision(pose, nextPose, rotationConfig, request.walls, angleSteps)) {
        return null;
      }
    } else if (isDrive) {
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

function generateFollowLineSteps(
  startPose: Pose2D,
  goal: { x: number; y: number },
  lineIndex: number,
  request: AStarWorkerRequest
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
  if (roundedDistance > 0) {
    const followStep = createFollowLineStep(roundedDistance);
    steps.push(followStep);

    const lineSegments = request.lineSegments ?? [];
    const detectDistance = getLineDetectDistance(request);
    const targetLine = lineSegments[lineIndex];
    const lineupContext = targetLine
      ? buildLineupContextForLine(request, targetLine, detectDistance)
      : buildLineupContext(request, lineSegments, detectDistance);

    if (lineupContext) {
      const followPoses = simulateFollowLine(pose, lineupContext, roundedDistance, false);
      if (followPoses.length) {
        pose = followPoses[followPoses.length - 1];
      } else {
        pose = forwardMove(pose, roundedDistance);
      }
    } else {
      pose = forwardMove(pose, roundedDistance);
    }
  }

  return { steps, finalPose: pose };
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

function createFollowLineStep(distanceCm: number): MissionStep {
  return {
    step_type: '',
    function_name: 'follow_line',
    arguments: [{ name: 'cm', value: distanceCm, type: 'float' }],
    position: { x: 0, y: 0 },
    children: [],
  };
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

function buildLineupContextForLine(
  request: AStarWorkerRequest,
  line: LineSegmentCm,
  detectDistanceCm: number
): LineupSimulationContext | null {
  const sensors = request.lineSensors ?? [];
  if (!sensors.length) return null;

  return {
    isOnBlackLine: (x, y) => isPointOnLineSegment(x, y, line, detectDistanceCm),
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

function isPointOnLineSegment(
  x: number,
  y: number,
  line: LineSegmentCm,
  detectDistanceCm: number
): boolean {
  const info = findClosestLineSegment([line], x, y);
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

function findFirstLineContactDistance(
  startPose: Pose2D,
  maxDistanceCm: number,
  direction: 'forward' | 'backward',
  context: LineupSimulationContext
): number | null {
  const step = 1;
  for (let distance = 0; distance <= maxDistanceCm; distance += step) {
    const signedDistance = direction === 'backward' ? -distance : distance;
    const pose = forwardMove(startPose, signedDistance);
    if (isAnySensorOnLine(pose, context)) {
      return distance;
    }
  }
  return null;
}

function findLastBlockingDistanceOnSegment(
  startPose: Pose2D,
  endPose: Pose2D,
  lineSegments: LineSegmentCm[],
  targetLineIndex: number
): number | null {
  const dx = endPose.x - startPose.x;
  const dy = endPose.y - startPose.y;
  const segmentLength = Math.sqrt(dx * dx + dy * dy);
  if (segmentLength === 0) return null;

  let lastDistance: number | null = null;
  for (let i = 0; i < lineSegments.length; i++) {
    if (i === targetLineIndex) continue;
    const line = lineSegments[i];
    const dist = segmentIntersectionDistance(
      startPose.x,
      startPose.y,
      endPose.x,
      endPose.y,
      line.startX,
      line.startY,
      line.endX,
      line.endY
    );
    if (dist === null) continue;
    if (dist > 0 && dist < segmentLength) {
      if (lastDistance === null || dist > lastDistance) {
        lastDistance = dist;
      }
    }
  }

  return lastDistance;
}

function segmentIntersectionDistance(
  p0x: number,
  p0y: number,
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  p3x: number,
  p3y: number
): number | null {
  const rX = p1x - p0x;
  const rY = p1y - p0y;
  const sX = p3x - p2x;
  const sY = p3y - p2y;
  const rxs = rX * sY - rY * sX;
  if (rxs === 0) return null;

  const qpx = p2x - p0x;
  const qpy = p2y - p0y;
  const t = (qpx * sY - qpy * sX) / rxs;
  const u = (qpx * rY - qpy * rX) / rxs;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;

  const segmentLength = Math.sqrt(rX * rX + rY * rY);
  return t * segmentLength;
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
    if (fn === 'follow_line') {
      const distance = (command.arguments[0]?.value as number) ?? 0;
      if (distance > 0) {
        const poses = simulateFollowLine(pose, context, distance, false);
        if (poses.length) {
          pose = poses[poses.length - 1];
        } else {
          pose = forwardMove(pose, distance);
        }
      }
      continue;
    }

    pose = simulateCommand(pose, command);
  }

  return pose;
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

function shouldFollowLineSegment(
  from: { lineup?: boolean; lineupLineIndex?: number },
  to: { lineup?: boolean; lineupLineIndex?: number }
): boolean {
  if (!from.lineup || !to.lineup) return false;
  if (typeof from.lineupLineIndex !== 'number' || typeof to.lineupLineIndex !== 'number') {
    return false;
  }
  return from.lineupLineIndex === to.lineupLineIndex;
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

function inflateRobotConfig(robotConfig: RobotConfig, clearanceCm: number): RobotConfig {
  if (clearanceCm <= 0) return robotConfig;
  return {
    ...robotConfig,
    widthCm: robotConfig.widthCm + clearanceCm * 2,
    lengthCm: robotConfig.lengthCm + clearanceCm * 2,
  };
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
