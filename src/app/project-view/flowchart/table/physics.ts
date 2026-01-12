import { MapConfig, WallSegmentCm } from './services';
import { Pose2D, normalizeAngle } from './models';
import { RobotConfig } from './services';

interface Vec2 {
  x: number;
  y: number;
}

export interface WallSegment {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface PathWithSegments {
  poses: Pose2D[];
  segments: number[];
}

const STEP_CM = 1;
const STEP_ANGLE_RAD = Math.PI / 36;
const EPS = 1e-6;
const MAX_ITERATIONS = 4000;

export function buildCollisionWalls(walls: WallSegmentCm[], config: MapConfig): WallSegment[] {
  const result: WallSegment[] = walls.map(seg => ({
    startX: seg.startX,
    startY: seg.startY,
    endX: seg.endX,
    endY: seg.endY,
  }));

  const width = config.widthCm;
  const height = config.heightCm;
  if (width > 0 && height > 0) {
    result.push(
      { startX: 0, startY: 0, endX: width, endY: 0 },
      { startX: width, startY: 0, endX: width, endY: height },
      { startX: width, startY: height, endX: 0, endY: height },
      { startX: 0, startY: height, endX: 0, endY: 0 },
    );
  }

  return result;
}

export function applyWallPhysicsToPath(poses: Pose2D[], robotConfig: RobotConfig, walls: WallSegment[]): Pose2D[] {
  return applyWallPhysicsToPathWithSegments(poses, robotConfig, walls).poses;
}

export function applyWallPhysicsToPathWithSegments(
  poses: Pose2D[],
  robotConfig: RobotConfig,
  walls: WallSegment[]
): PathWithSegments {
  if (!poses?.length) return { poses: [], segments: [] };
  if (poses.length === 1 || !walls.length) {
    return { poses: poses.slice(), segments: poses.length > 1 ? poses.slice(1).map((_, idx) => idx) : [] };
  }

  const output: Pose2D[] = [poses[0]];
  const segments: number[] = [];
  let current = poses[0];

  for (let i = 0; i < poses.length - 1; i++) {
    const target = poses[i + 1];
    const segmentPoses = simulateSegment(current, target, robotConfig, walls);
    if (segmentPoses.length) {
      for (const pose of segmentPoses) {
        output.push(pose);
        segments.push(i);
        current = pose;
      }
    } else {
      current = target;
    }
  }

  return { poses: output, segments };
}

interface CollisionInfo {
  wall: WallSegment;
  normal: Vec2;
  tangent: Vec2;
  depth: number;
}

function simulateSegment(
  start: Pose2D,
  target: Pose2D,
  robotConfig: RobotConfig,
  walls: WallSegment[]
): Pose2D[] {
  const poses: Pose2D[] = [];
  let current = { ...start };
  let remainingMove = {
    x: target.x - current.x,
    y: target.y - current.y,
  };
  let remainingTheta = normalizeAngle(target.theta - current.theta);

  let iterations = 0;
  while (iterations < MAX_ITERATIONS) {
    iterations += 1;
    const distance = length(remainingMove);
    const angleAbs = Math.abs(remainingTheta);

    if (distance <= EPS && angleAbs <= EPS) {
      break;
    }

    const stepDist = distance > EPS ? Math.min(STEP_CM, distance) : 0;
    const stepTheta = angleAbs > EPS ? Math.sign(remainingTheta) * Math.min(STEP_ANGLE_RAD, angleAbs) : 0;
    const direction = distance > EPS ? scale(remainingMove, 1 / distance) : { x: 0, y: 0 };
    const stepMove = scale(direction, stepDist);
    const attempted: Pose2D = {
      x: current.x + stepMove.x,
      y: current.y + stepMove.y,
      theta: normalizeAngle(current.theta + stepTheta),
    };

    const collision = stepDist > EPS ? findCollision(attempted, robotConfig, walls) : null;
    if (!collision) {
      current = attempted;
      remainingMove = {
        x: remainingMove.x - stepMove.x,
        y: remainingMove.y - stepMove.y,
      };
      remainingTheta = normalizeAngle(remainingTheta - stepTheta);
      if (stepDist > EPS || Math.abs(stepTheta) > EPS) {
        poses.push(current);
      }
      continue;
    }

    const stopped = resolvePoseAgainstWall(attempted, collision, robotConfig);
    const movedVec = {
      x: stopped.x - current.x,
      y: stopped.y - current.y,
    };
    const remainingAfter = {
      x: remainingMove.x - movedVec.x,
      y: remainingMove.y - movedVec.y,
    };

    const tangentDir = dot(remainingAfter, collision.tangent) >= 0 ? collision.tangent : negate(collision.tangent);
    const remainingAlong = dot(remainingAfter, tangentDir);

    if (remainingAlong <= EPS) {
      const moved = Math.abs(stopped.x - current.x) > EPS || Math.abs(stopped.y - current.y) > EPS;
      const rotated = Math.abs(normalizeAngle(stopped.theta - current.theta)) > EPS;
      if (moved || rotated) {
        current = stopped;
        poses.push(current);
      }
      break;
    }

    const aligned: Pose2D = {
      x: stopped.x,
      y: stopped.y,
      theta: Math.atan2(tangentDir.y, tangentDir.x),
    };
    const moved = Math.abs(aligned.x - current.x) > EPS || Math.abs(aligned.y - current.y) > EPS;
    const rotated = Math.abs(normalizeAngle(aligned.theta - current.theta)) > EPS;
    current = aligned;
    if (moved || rotated) {
      poses.push(current);
    }

    remainingMove = scale(tangentDir, remainingAlong);
    remainingTheta = 0;
    continue;
  }

  return poses;
}

function findCollision(
  pose: Pose2D,
  robotConfig: RobotConfig,
  walls: WallSegment[]
): CollisionInfo | null {
  let best: CollisionInfo | null = null;
  for (const wall of walls) {
    const collision = computeCollision(pose, robotConfig, wall);
    if (!collision) continue;
    if (!best || collision.depth > best.depth) {
      best = collision;
    }
  }
  return best;
}

function computeCollision(
  pose: Pose2D,
  robotConfig: RobotConfig,
  wall: WallSegment
): CollisionInfo | null {
  const wallVec = {
    x: wall.endX - wall.startX,
    y: wall.endY - wall.startY,
  };
  const wallLength = length(wallVec);
  if (wallLength <= EPS) return null;

  const tangent = scale(wallVec, 1 / wallLength);
  const normal = { x: -tangent.y, y: tangent.x };
  const rect = getRectangle(pose, robotConfig);
  const centerToStart = {
    x: rect.center.x - wall.startX,
    y: rect.center.y - wall.startY,
  };

  const radiusAlongTangent = rect.halfLength * Math.abs(dot(tangent, rect.forward))
    + rect.halfWidth * Math.abs(dot(tangent, rect.left));
  const proj = dot(centerToStart, tangent);
  if (proj + radiusAlongTangent < 0 || proj - radiusAlongTangent > wallLength) {
    return null;
  }

  const support = rect.halfLength * Math.abs(dot(normal, rect.forward))
    + rect.halfWidth * Math.abs(dot(normal, rect.left));
  const signedDistance = dot(centerToStart, normal);
  const absDistance = Math.abs(signedDistance);

  if (absDistance < support - EPS) {
    const correctionNormal = signedDistance >= 0 ? normal : negate(normal);
    return {
      wall,
      normal: correctionNormal,
      tangent,
      depth: support - absDistance,
    };
  }

  return null;
}

function resolvePoseAgainstWall(pose: Pose2D, collision: CollisionInfo, robotConfig: RobotConfig): Pose2D {
  const rect = getRectangle(pose, robotConfig);
  const toStart = {
    x: rect.center.x - collision.wall.startX,
    y: rect.center.y - collision.wall.startY,
  };
  const support = rect.halfLength * Math.abs(dot(collision.normal, rect.forward))
    + rect.halfWidth * Math.abs(dot(collision.normal, rect.left));
  const distanceToWall = dot(toStart, collision.normal) - support;
  if (distanceToWall >= 0) return pose;

  const correction = -distanceToWall;
  return {
    x: pose.x + collision.normal.x * correction,
    y: pose.y + collision.normal.y * correction,
    theta: pose.theta,
  };
}

function getRectangle(pose: Pose2D, robotConfig: RobotConfig) {
  const cos = Math.cos(pose.theta);
  const sin = Math.sin(pose.theta);
  const forward = { x: cos, y: sin };
  const left = { x: -sin, y: cos };

  const centerLocal = {
    x: -robotConfig.rotationCenterForwardCm,
    y: robotConfig.rotationCenterStrafeCm,
  };
  const center = {
    x: pose.x + centerLocal.x * cos - centerLocal.y * sin,
    y: pose.y + centerLocal.x * sin + centerLocal.y * cos,
  };

  return {
    center,
    forward,
    left,
    halfLength: robotConfig.lengthCm / 2,
    halfWidth: robotConfig.widthCm / 2,
  };
}

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

function length(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

function scale(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s };
}

function negate(v: Vec2): Vec2 {
  return { x: -v.x, y: -v.y };
}
