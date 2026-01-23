import { MissionStep } from '../../../../entities/MissionStep';
import { Waypoint } from './models';
import { Pose2D, applyLocalDelta, forwardMove, normalizeAngle } from '../models';
import { LineSegmentCm } from '../services';
import { SensorConfig } from '../models';
import { lineupProximityCm } from './line-utils';
import {
  LineupSimulationContext,
  simulateForwardLineupOnBlack,
} from '../simulation-path';

// --- Interfaces ---

export interface OptimizationContext {
  lineSegments: LineSegmentCm[];
  sensorConfig: SensorConfig;
  isOnBlackLine: (x: number, y: number) => boolean;
  rotationCenterForwardCm?: number;
  rotationCenterStrafeCm?: number;
  maxLineupDistanceCm?: number;
}

export interface OptimizationOptions {
  /** Lineup angle threshold: 0=permissive, 1=strict (default: 0.5) */
  lineupThreshold?: number;
  /** Use tank turn functions (default: false) */
  useTankTurn?: boolean;
  /** Minimum rotation in degrees to generate turn step (default: 1) */
  minRotateDeg?: number;
}

// --- Main Optimizer Function ---

/**
 * Convert waypoints to optimized mission steps.
 */
export function optimizeWaypointsToSteps(
  waypoints: Waypoint[],
  startPose: Pose2D,
  context: OptimizationContext,
  options?: OptimizationOptions
): MissionStep[] {
  if (waypoints.length < 2) return [];

  const useTankTurn = options?.useTankTurn ?? false;
  const minRotateDeg = options?.minRotateDeg ?? 1;
  const lineupThreshold = options?.lineupThreshold ?? 0.5;
  const lineSegments = context.lineSegments ?? [];
  const detectDistanceCm = Math.max(1.5, lineupProximityCm(lineupThreshold) * 0.5);
  const lineupContext = buildLineupContext(context);

  const steps: MissionStep[] = [];
  let currentPose: Pose2D = { ...startPose };

  for (let i = 0; i < waypoints.length - 1; i++) {
    const to = waypoints[i + 1];
    let guard = 0;
    while (guard < 6) {
      guard += 1;
      const dx = to.x - currentPose.x;
      const dy = to.y - currentPose.y;
      const totalDistance = Math.sqrt(dx * dx + dy * dy);

      const shouldLineup = !!to.lineup;
      if (totalDistance < 0.1 && !shouldLineup) {
        break;
      }

      // Calculate required heading
      const targetHeading = Math.atan2(dy, dx);
      const angleDiff = normalizeAngle(targetHeading - currentPose.theta);
      const angleDeg = angleDiff * (180 / Math.PI);

      // Generate turn step if needed
      const roundedAngle = Math.round(angleDeg);
      if (Math.abs(roundedAngle) >= minRotateDeg) {
        steps.push(createTurnStep(roundedAngle, useTankTurn));
        currentPose = {
          ...currentPose,
          theta: normalizeAngle(currentPose.theta + roundedAngle * Math.PI / 180),
        };
      }

      if (shouldLineup) {
        const approachOffset = getLineupApproachOffset(
          context.sensorConfig,
          context.rotationCenterForwardCm ?? 0,
          'forward'
        );
        const targetLine = typeof to.lineupLineIndex === 'number'
          ? lineSegments[to.lineupLineIndex]
          : null;
        const targetDistance = targetLine
          ? segmentIntersectionDistance(
            currentPose.x,
            currentPose.y,
            to.x,
            to.y,
            targetLine.startX,
            targetLine.startY,
            targetLine.endX,
            targetLine.endY
          ) ?? totalDistance
          : totalDistance;
        const blockingDistance = findLastBlockingLineDistance(
          currentPose.x,
          currentPose.y,
          to.x,
          to.y,
          lineSegments,
          typeof to.lineupLineIndex === 'number' ? to.lineupLineIndex : null
        );
        let approachDistance = Math.max(0, targetDistance - approachOffset);
        if (blockingDistance !== null) {
          approachDistance = Math.max(approachDistance, blockingDistance + 1);
        }
        approachDistance = Math.min(approachDistance, Math.max(0, targetDistance - 0.5));

        const activeContext = targetLine
          ? buildLineupContextForLine(context, targetLine, detectDistanceCm)
          : lineupContext;
        const contactDistance = activeContext
          ? findFirstLineContactDistance(currentPose, targetDistance, activeContext)
          : null;
        if (contactDistance !== null) {
          approachDistance = Math.min(approachDistance, Math.max(0, contactDistance - 1));
        }
        approachDistance = backoffApproachDistance(currentPose, approachDistance, activeContext);

        const roundedDistance = Math.round(approachDistance);
        if (roundedDistance > 0) {
          steps.push(createDriveStep(roundedDistance));
          currentPose = forwardMove(currentPose, roundedDistance);
        }

        steps.push(createLineupStep('forward', 'black'));
        if (activeContext) {
          const lineupPoses = simulateForwardLineupOnBlack(currentPose, activeContext);
          if (lineupPoses.length) {
            currentPose = lineupPoses[lineupPoses.length - 1];
          }
        }
        break;
      }

      if (totalDistance > 1) {
        const roundedDistance = Math.round(totalDistance);
        if (roundedDistance > 0) {
          steps.push(createDriveStep(roundedDistance));
          currentPose = forwardMove(currentPose, roundedDistance);
        }
      }

      break;
    }
  }

  return steps;
}

// --- Helper Functions ---

// --- Step Creation Functions ---

function createTurnStep(angleDeg: number, useTank: boolean): MissionStep {
  const isClockwise = angleDeg < 0;
  const functionName = useTank
    ? (isClockwise ? 'tank_turn_cw' : 'tank_turn_ccw')
    : (isClockwise ? 'turn_cw' : 'turn_ccw');

  return {
    step_type: '',
    function_name: functionName,
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

function buildLineupContext(context: OptimizationContext, maxDistanceCm?: number): LineupSimulationContext | null {
  const sensors = context.sensorConfig?.lineSensors ?? [];
  if (sensors.length === 0) return null;

  return {
    isOnBlackLine: context.isOnBlackLine,
    lineSensors: sensors,
    rotationCenterForwardCm: context.rotationCenterForwardCm ?? 0,
    rotationCenterStrafeCm: context.rotationCenterStrafeCm ?? 0,
    maxDistanceCm: maxDistanceCm ?? context.maxLineupDistanceCm,
  };
}

function buildLineupContextForLine(
  context: OptimizationContext,
  line: LineSegmentCm,
  detectDistanceCm: number
): LineupSimulationContext | null {
  const sensors = context.sensorConfig?.lineSensors ?? [];
  if (sensors.length === 0) return null;

  return {
    isOnBlackLine: (x, y) => isPointOnLineSegment(x, y, line, detectDistanceCm),
    lineSensors: sensors,
    rotationCenterForwardCm: context.rotationCenterForwardCm ?? 0,
    rotationCenterStrafeCm: context.rotationCenterStrafeCm ?? 0,
    maxDistanceCm: context.maxLineupDistanceCm,
  };
}

function isPointOnLineSegment(
  x: number,
  y: number,
  line: LineSegmentCm,
  detectDistanceCm: number
): boolean {
  const closest = closestPointOnSegment(
    x,
    y,
    line.startX,
    line.startY,
    line.endX,
    line.endY
  );
  const dx = x - closest.x;
  const dy = y - closest.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return dist <= detectDistanceCm;
}

function closestPointOnSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return { x: x1, y: y1 };

  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return { x: x1 + t * dx, y: y1 + t * dy };
}

function backoffApproachDistance(
  startPose: Pose2D,
  distanceCm: number,
  context: LineupSimulationContext | null
): number {
  if (!context || distanceCm <= 0) return distanceCm;
  let adjusted = distanceCm;
  let guard = 0;
  while (adjusted > 0 && guard < 300) {
    const pose = forwardMove(startPose, adjusted);
    if (!isAnySensorOnLine(pose, context)) {
      break;
    }
    adjusted = Math.max(0, adjusted - 1);
    guard += 1;
  }
  return adjusted;
}

function findFirstLineContactDistance(
  startPose: Pose2D,
  maxDistanceCm: number,
  context: LineupSimulationContext
): number | null {
  const step = 1;
  for (let distance = 0; distance <= maxDistanceCm; distance += step) {
    const pose = forwardMove(startPose, distance);
    if (isAnySensorOnLine(pose, context)) {
      return distance;
    }
  }
  return null;
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

function findLastBlockingLineDistance(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  lineSegments: LineSegmentCm[],
  targetLineIndex: number | null
): number | null {
  const dx = endX - startX;
  const dy = endY - startY;
  const segmentLength = Math.sqrt(dx * dx + dy * dy);
  if (segmentLength === 0) return null;

  let lastDistance: number | null = null;
  for (let i = 0; i < lineSegments.length; i++) {
    if (targetLineIndex !== null && i === targetLineIndex) continue;
    const line = lineSegments[i];
    const dist = segmentIntersectionDistance(
      startX,
      startY,
      endX,
      endY,
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

function getLineupApproachOffset(
  sensorConfig: SensorConfig,
  rotationCenterForwardCm: number,
  direction: 'forward' | 'backward'
): number {
  const sensors = sensorConfig?.lineSensors ?? [];
  if (!sensors.length) return 2;

  let maxProjection = Number.NEGATIVE_INFINITY;
  const sign = direction === 'forward' ? 1 : -1;

  for (const sensor of sensors) {
    const forwardFromRc = sensor.forwardCm - rotationCenterForwardCm;
    const projection = forwardFromRc * sign;
    if (projection > maxProjection) maxProjection = projection;
  }

  const offset = Math.max(0, maxProjection);
  return Math.max(3, offset + 2);
}

// No line-snapping heuristics here; lineup steps are explicitly requested by waypoint flags.
