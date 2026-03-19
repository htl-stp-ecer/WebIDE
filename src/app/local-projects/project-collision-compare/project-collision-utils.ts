import { ProjectSimulationData } from '../../entities/Simulation';
import { Pose2D, createPose, lerpPose } from '../../project-view/flowchart/table/models';
import { LineSensor } from '../../project-view/flowchart/table/models';
import {
  buildTimedPlannedPathFromProjectSimulation,
  MissionPlannedRange,
  TimedPoseIndexFrame,
} from '../../project-view/flowchart/table/simulation-path';
import {
  applyWallPhysicsToPathWithSegments,
  buildCollisionWalls,
  PathWithSegments,
} from '../../project-view/flowchart/table/physics';
import {
  MapConfig,
  RobotConfig,
  LineSegmentCm,
  WallSegmentCm,
} from '../../project-view/flowchart/table/services';

const DEFAULT_WIDTH_CM = 15;
const DEFAULT_LENGTH_CM = 22;
const DEFAULT_SAMPLE_MS = 50;
const EPSILON = 1e-6;

interface Vec2 {
  x: number;
  y: number;
}

export interface ProjectMapGeometry {
  config: MapConfig;
  lineSegmentsCm: LineSegmentCm[];
  wallSegmentsCm: WallSegmentCm[];
  isLoaded: boolean;
  isOnBlackLine(xCm: number, yCm: number): boolean;
}

export interface TimedPoseFrame {
  timeMs: number;
  pose: Pose2D;
}

export interface TimedProjectPath {
  frames: TimedPoseFrame[];
  totalDurationMs: number;
}

export interface ProjectComparisonData {
  projectUuid: string;
  projectName: string;
  startPose: Pose2D;
  robotConfig: RobotConfig;
  map: ProjectMapGeometry;
  simulation: ProjectSimulationData;
  plannedPath: Pose2D[];
  missionRanges: MissionPlannedRange[];
  timedPath: TimedProjectPath;
}

export interface ProjectCollisionEvent {
  key: string;
  projectAUuid: string;
  projectAName: string;
  projectBUuid: string;
  projectBName: string;
  timeMs: number;
  point: { x: number; y: number };
  poseA: Pose2D;
  poseB: Pose2D;
}

export function buildProjectComparisonData(
  project: Pick<Project, 'uuid' | 'name'>,
  simulation: ProjectSimulationData,
  info: ConnectionInfo | null | undefined,
  map: ProjectMapGeometry
): ProjectComparisonData {
  const robotConfig = createRobotConfig(info);
  const sensors = createLineSensors(info, robotConfig);
  const startPose = createStartPose(info);
  const lineupContext = map.isLoaded && sensors.length >= 2
    ? {
        isOnBlackLine: (xCm: number, yCm: number) => map.isOnBlackLine(xCm, yCm),
        lineSensors: sensors,
        rotationCenterForwardCm: robotConfig.rotationCenterForwardCm,
        rotationCenterStrafeCm: robotConfig.rotationCenterStrafeCm,
        maxDistanceCm: Math.max(map.config.widthCm, map.config.heightCm),
      }
    : null;

  const planned = buildTimedPlannedPathFromProjectSimulation(startPose, simulation, { lineup: lineupContext });
  const adjusted = applyWallPhysicsToPathWithSegments(
    planned.poses,
    robotConfig,
    buildCollisionWalls(map.wallSegmentsCm, map.config)
  );
  const missionRanges = mapMissionRanges(planned.missionRanges, adjusted, planned.poses.length);
  const timedPath = buildTimedPathFromFrames(planned.frames, adjusted, planned.poses.length);

  return {
    projectUuid: project.uuid,
    projectName: project.name,
    startPose,
    robotConfig,
    map,
    simulation,
    plannedPath: adjusted.poses,
    missionRanges,
    timedPath,
  };
}

export function buildTimedPathFromFrames(
  frames: TimedPoseIndexFrame[],
  adjusted: PathWithSegments,
  rawPoseCount: number
): TimedProjectPath {
  if (!adjusted.poses.length || !frames.length || rawPoseCount <= 0) {
    return { frames: [], totalDurationMs: 0 };
  }

  const rawToAdjusted = mapRawPoseIndicesToAdjusted(adjusted, rawPoseCount);
  const timedFrames: TimedPoseFrame[] = [];
  for (const frame of frames) {
    const adjustedIndex = rawToAdjusted[clamp(frame.poseIndex, 0, rawPoseCount - 1)] ?? 0;
    const pose = adjusted.poses[adjustedIndex] ?? adjusted.poses[adjusted.poses.length - 1];
    pushFrame(timedFrames, frame.timeMs, pose);
  }

  return {
    frames: timedFrames,
    totalDurationMs: frames[frames.length - 1]?.timeMs ?? 0,
  };
}

export function interpolatePoseAtTime(path: TimedProjectPath, timeMs: number): Pose2D | null {
  const frames = path.frames;
  if (!frames.length) return null;
  if (timeMs <= frames[0].timeMs) return frames[0].pose;

  for (let index = 1; index < frames.length; index++) {
    const previous = frames[index - 1];
    const current = frames[index];
    if (timeMs > current.timeMs) continue;
    const duration = current.timeMs - previous.timeMs;
    if (duration <= EPSILON) {
      return current.pose;
    }
    return lerpPose(previous.pose, current.pose, (timeMs - previous.timeMs) / duration);
  }

  return frames[frames.length - 1].pose;
}

export function detectProjectCollisions(
  projects: ProjectComparisonData[],
  sampleMs: number = DEFAULT_SAMPLE_MS
): ProjectCollisionEvent[] {
  if (projects.length < 2) return [];

  const totalDurationMs = Math.max(...projects.map(project => project.timedPath.totalDurationMs), 0);
  const intervalMs = Math.max(1, sampleMs);
  const activePairs = new Set<string>();
  const collisions: ProjectCollisionEvent[] = [];

  const sampleTimes: number[] = [];
  if (totalDurationMs <= 0) {
    sampleTimes.push(0);
  } else {
    for (let timeMs = 0; timeMs <= totalDurationMs; timeMs += intervalMs) {
      sampleTimes.push(timeMs);
    }
    if (sampleTimes[sampleTimes.length - 1] !== totalDurationMs) {
      sampleTimes.push(totalDurationMs);
    }
  }

  for (const timeMs of sampleTimes) {
    for (let left = 0; left < projects.length - 1; left++) {
      for (let right = left + 1; right < projects.length; right++) {
        const projectA = projects[left];
        const projectB = projects[right];
        const pairKey = buildPairKey(projectA.projectUuid, projectB.projectUuid);
        const poseA = interpolatePoseAtTime(projectA.timedPath, timeMs);
        const poseB = interpolatePoseAtTime(projectB.timedPath, timeMs);
        if (!poseA || !poseB) continue;

        const overlaps = doRobotFootprintsOverlap(poseA, projectA.robotConfig, poseB, projectB.robotConfig);
        if (!overlaps) {
          activePairs.delete(pairKey);
          continue;
        }
        if (activePairs.has(pairKey)) {
          continue;
        }

        activePairs.add(pairKey);
        collisions.push({
          key: `${pairKey}:${Math.round(timeMs)}`,
          projectAUuid: projectA.projectUuid,
          projectAName: projectA.projectName,
          projectBUuid: projectB.projectUuid,
          projectBName: projectB.projectName,
          timeMs,
          point: {
            x: (poseA.x + poseB.x) / 2,
            y: (poseA.y + poseB.y) / 2,
          },
          poseA,
          poseB,
        });
      }
    }
  }

  return collisions;
}

export function doRobotFootprintsOverlap(
  poseA: Pose2D,
  robotA: RobotConfig,
  poseB: Pose2D,
  robotB: RobotConfig
): boolean {
  const rectA = getRobotRectangle(poseA, robotA);
  const rectB = getRobotRectangle(poseB, robotB);
  const axes = [rectA.forward, rectA.left, rectB.forward, rectB.left];
  const centerDelta = subtract(rectB.center, rectA.center);

  for (const axis of axes) {
    const distance = Math.abs(dot(centerDelta, axis));
    const radiusA = projectedRadius(rectA, axis);
    const radiusB = projectedRadius(rectB, axis);
    if (distance > radiusA + radiusB + EPSILON) {
      return false;
    }
  }

  return true;
}

function createRobotConfig(info: ConnectionInfo | null | undefined): RobotConfig {
  const widthCm = isPositiveNumber(info?.width_cm) ? info.width_cm : DEFAULT_WIDTH_CM;
  const lengthCm = isPositiveNumber(info?.length_cm) ? info.length_cm : DEFAULT_LENGTH_CM;

  let rotationCenterForwardCm = 0;
  let rotationCenterStrafeCm = 0;
  if (info?.rotation_center) {
    rotationCenterForwardCm = info.rotation_center.y_cm - lengthCm / 2;
    rotationCenterStrafeCm = (widthCm / 2) - info.rotation_center.x_cm;
  }

  return {
    widthCm,
    lengthCm,
    rotationCenterForwardCm,
    rotationCenterStrafeCm,
  };
}

function createLineSensors(
  info: ConnectionInfo | null | undefined,
  robotConfig: RobotConfig
): LineSensor[] {
  const sensors = info?.sensors ?? [];
  return sensors
    .filter(sensor => typeof sensor.x_cm === 'number' && typeof sensor.y_cm === 'number')
    .map((sensor, index) => ({
      index,
      forwardCm: sensor.y_cm! - robotConfig.lengthCm / 2,
      strafeCm: (robotConfig.widthCm / 2) - sensor.x_cm!,
    }));
}

function createStartPose(info: ConnectionInfo | null | undefined): Pose2D {
  const startPose = info?.start_pose;
  if (!startPose) {
    return createPose(20, 50, 0);
  }
  return createPose(startPose.x_cm, startPose.y_cm, startPose.theta_deg);
}

function mapMissionRanges(
  ranges: MissionPlannedRange[],
  adjusted: PathWithSegments,
  plannedLength: number
): MissionPlannedRange[] {
  if (!adjusted.poses.length) return [];
  const segmentCount = Math.max(0, plannedLength - 1);
  if (segmentCount === 0) {
    return ranges.map(range => ({
      ...range,
      startIndex: 0,
      endIndex: 0,
    }));
  }

  const segmentEndIndex = buildSegmentEndIndex(adjusted, segmentCount);
  const mapIndex = (index: number): number => {
    if (index <= 0) return 0;
    const segmentIndex = Math.min(index - 1, segmentCount - 1);
    return segmentEndIndex[segmentIndex] ?? 0;
  };

  return ranges.map(range => ({
    ...range,
    startIndex: mapIndex(range.startIndex),
    endIndex: mapIndex(range.endIndex),
  }));
}

function mapRawPoseIndicesToAdjusted(adjusted: PathWithSegments, rawPoseCount: number): number[] {
  if (rawPoseCount <= 0 || !adjusted.poses.length) {
    return [];
  }

  const rawToAdjusted = new Array<number>(rawPoseCount).fill(0);
  if (rawPoseCount === 1) {
    return rawToAdjusted;
  }

  const segmentEndIndex = buildSegmentEndIndex(adjusted, rawPoseCount - 1);
  for (let poseIndex = 1; poseIndex < rawPoseCount; poseIndex++) {
    rawToAdjusted[poseIndex] = segmentEndIndex[poseIndex - 1] ?? rawToAdjusted[poseIndex - 1];
  }

  return rawToAdjusted;
}

function buildSegmentEndIndex(adjusted: PathWithSegments, segmentCount: number): number[] {
  const segmentEndIndex = new Array<number>(segmentCount).fill(0);
  for (let index = 0; index < adjusted.segments.length; index++) {
    const segmentIndex = adjusted.segments[index];
    if (segmentIndex < 0 || segmentIndex >= segmentCount) continue;
    segmentEndIndex[segmentIndex] = index + 1;
  }

  for (let index = 1; index < segmentCount; index++) {
    if (segmentEndIndex[index] === 0) {
      segmentEndIndex[index] = segmentEndIndex[index - 1];
    }
  }

  return segmentEndIndex;
}

function getRobotRectangle(pose: Pose2D, robot: RobotConfig) {
  const cos = Math.cos(pose.theta);
  const sin = Math.sin(pose.theta);
  const forward = { x: cos, y: sin };
  const left = { x: -sin, y: cos };
  const center = {
    x: pose.x - robot.rotationCenterForwardCm * cos - robot.rotationCenterStrafeCm * sin,
    y: pose.y - robot.rotationCenterForwardCm * sin + robot.rotationCenterStrafeCm * cos,
  };

  return {
    center,
    forward,
    left,
    halfLength: robot.lengthCm / 2,
    halfWidth: robot.widthCm / 2,
  };
}

function projectedRadius(
  rect: {
    forward: Vec2;
    left: Vec2;
    halfLength: number;
    halfWidth: number;
  },
  axis: Vec2
): number {
  return rect.halfLength * Math.abs(dot(rect.forward, axis)) + rect.halfWidth * Math.abs(dot(rect.left, axis));
}

function pushFrame(frames: TimedPoseFrame[], timeMs: number, pose: Pose2D): void {
  const last = frames[frames.length - 1];
  if (!last) {
    frames.push({ timeMs, pose });
    return;
  }

  if (
    Math.abs(last.timeMs - timeMs) <= EPSILON &&
    Math.abs(last.pose.x - pose.x) <= EPSILON &&
    Math.abs(last.pose.y - pose.y) <= EPSILON &&
    Math.abs(last.pose.theta - pose.theta) <= EPSILON
  ) {
    return;
  }

  frames.push({ timeMs, pose });
}

function buildPairKey(leftUuid: string, rightUuid: string): string {
  return [leftUuid, rightUuid].sort().join(':');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}
