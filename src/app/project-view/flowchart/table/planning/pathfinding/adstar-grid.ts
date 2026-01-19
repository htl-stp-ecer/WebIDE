import { Pose2D } from '../../models';
import { MapConfig, RobotConfig } from '../../services';
import { WallSegment, checkRobotCollision, isRobotInBounds } from '../../physics';

// Ported and simplified from PathPlanner's LocalADStar (MIT License).

const DEFAULT_EPS = 2.5;
const DEFAULT_NODE_SIZE_CM = 5;
const DEFAULT_MAX_ITERS_MULTIPLIER = 20;

export interface GridPosition {
  x: number;
  y: number;
}

export interface AdStarGrid {
  nodeSizeCm: number;
  nodesX: number;
  nodesY: number;
  blocked: Uint8Array;
}

export interface AdStarConfig {
  eps?: number;
  maxIterations?: number;
  refine?: boolean;
}

export interface GridPathResult {
  nodes: GridPosition[];
  points: { x: number; y: number }[];
}

export function buildAdStarGrid(
  walls: WallSegment[],
  mapConfig: MapConfig,
  robotConfig: RobotConfig,
  nodeSizeCm: number = DEFAULT_NODE_SIZE_CM
): AdStarGrid {
  const nodesX = Math.max(1, Math.ceil(mapConfig.widthCm / nodeSizeCm));
  const nodesY = Math.max(1, Math.ceil(mapConfig.heightCm / nodeSizeCm));
  const blocked = new Uint8Array(nodesX * nodesY);

  for (let y = 0; y < nodesY; y++) {
    for (let x = 0; x < nodesX; x++) {
      const pose: Pose2D = {
        x: (x + 0.5) * nodeSizeCm,
        y: (y + 0.5) * nodeSizeCm,
        theta: 0,
      };
      const inBounds = isRobotInBounds(pose, mapConfig, robotConfig);
      const collides = checkRobotCollision(pose, robotConfig, walls);
      if (!inBounds || collides) {
        blocked[indexOf(x, y, nodesX)] = 1;
      }
    }
  }

  return { nodeSizeCm, nodesX, nodesY, blocked };
}

export function findAdStarPath(
  startPose: Pose2D,
  goal: { x: number; y: number },
  grid: AdStarGrid,
  config?: AdStarConfig
): GridPathResult | null {
  const start = findClosestFree(getGridPos(startPose, grid), grid);
  const goalPos = findClosestFree(getGridPos(goal, grid), grid);
  if (!start || !goalPos) return null;

  const size = grid.nodesX * grid.nodesY;
  const g = new Float64Array(size);
  const rhs = new Float64Array(size);
  g.fill(Number.POSITIVE_INFINITY);
  rhs.fill(Number.POSITIVE_INFINITY);

  const open = new Map<number, Pair>();
  const incons = new Set<number>();
  const closed = new Set<number>();

  const epsStart = config?.eps ?? DEFAULT_EPS;
  let eps = epsStart;
  const maxIterations = config?.maxIterations ?? size * DEFAULT_MAX_ITERS_MULTIPLIER;

  reset(start, goalPos, g, rhs, open, closed, incons, eps, grid);
  computeOrImprovePath(start, goalPos, g, rhs, open, closed, incons, eps, grid, maxIterations);

  if (config?.refine ?? true) {
    while (eps > 1.0 + 1e-6) {
      eps = Math.max(1.0, eps - 0.5);
      for (const s of incons) {
        open.set(s, key(indexToPos(s, grid.nodesX), start, g, rhs, eps, grid));
      }
      incons.clear();
      for (const s of open.keys()) {
        open.set(s, key(indexToPos(s, grid.nodesX), start, g, rhs, eps, grid));
      }
      closed.clear();
      computeOrImprovePath(start, goalPos, g, rhs, open, closed, incons, eps, grid, maxIterations);
    }
  }

  const pathNodes = extractPath(start, goalPos, g, grid);
  if (!pathNodes.length) return null;

  const simplified = simplifyPath(pathNodes, grid);
  const points = simplified.map(pos => gridPosToPoint(pos, grid));
  if (points.length >= 2) {
    points[0] = { x: startPose.x, y: startPose.y };
    points[points.length - 1] = { x: goal.x, y: goal.y };
  }

  return { nodes: simplified, points };
}

function reset(
  start: GridPosition,
  goal: GridPosition,
  g: Float64Array,
  rhs: Float64Array,
  open: Map<number, Pair>,
  closed: Set<number>,
  incons: Set<number>,
  eps: number,
  grid: AdStarGrid
): void {
  g.fill(Number.POSITIVE_INFINITY);
  rhs.fill(Number.POSITIVE_INFINITY);
  open.clear();
  closed.clear();
  incons.clear();

  rhs[indexOf(goal.x, goal.y, grid.nodesX)] = 0;
  open.set(indexOf(goal.x, goal.y, grid.nodesX), key(goal, start, g, rhs, eps, grid));
}

function computeOrImprovePath(
  start: GridPosition,
  goal: GridPosition,
  g: Float64Array,
  rhs: Float64Array,
  open: Map<number, Pair>,
  closed: Set<number>,
  incons: Set<number>,
  eps: number,
  grid: AdStarGrid,
  maxIterations: number
): void {
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    const top = topKey(open);
    if (!top) break;
    const [sIndex, keyValue] = top;

    if (
      comparePair(keyValue, key(start, start, g, rhs, eps, grid)) >= 0 &&
      rhs[indexOf(start.x, start.y, grid.nodesX)] === g[indexOf(start.x, start.y, grid.nodesX)]
    ) {
      break;
    }

    open.delete(sIndex);
    const s = indexToPos(sIndex, grid.nodesX);
    const sG = g[sIndex];
    const sRhs = rhs[sIndex];

    if (sG > sRhs) {
      g[sIndex] = sRhs;
      closed.add(sIndex);
      for (const neighbor of getOpenNeighbors(s, grid)) {
        updateState(neighbor, start, goal, g, rhs, open, closed, incons, eps, grid);
      }
    } else {
      g[sIndex] = Number.POSITIVE_INFINITY;
      for (const neighbor of getOpenNeighbors(s, grid)) {
        updateState(neighbor, start, goal, g, rhs, open, closed, incons, eps, grid);
      }
      updateState(s, start, goal, g, rhs, open, closed, incons, eps, grid);
    }
  }
}

function updateState(
  s: GridPosition,
  start: GridPosition,
  goal: GridPosition,
  g: Float64Array,
  rhs: Float64Array,
  open: Map<number, Pair>,
  closed: Set<number>,
  incons: Set<number>,
  eps: number,
  grid: AdStarGrid
): void {
  const sIndex = indexOf(s.x, s.y, grid.nodesX);
  if (!positionsEqual(s, goal)) {
    rhs[sIndex] = Number.POSITIVE_INFINITY;
    for (const neighbor of getOpenNeighbors(s, grid)) {
      const nIndex = indexOf(neighbor.x, neighbor.y, grid.nodesX);
      const costValue = cost(s, neighbor, grid);
      rhs[sIndex] = Math.min(rhs[sIndex], g[nIndex] + costValue);
    }
  }

  open.delete(sIndex);
  if (g[sIndex] !== rhs[sIndex]) {
    if (!closed.has(sIndex)) {
      open.set(sIndex, key(s, start, g, rhs, eps, grid));
    } else {
      incons.add(sIndex);
    }
  }
}

function extractPath(
  start: GridPosition,
  goal: GridPosition,
  g: Float64Array,
  grid: AdStarGrid
): GridPosition[] {
  if (positionsEqual(start, goal)) return [];

  const path: GridPosition[] = [start];
  let current = start;

  for (let i = 0; i < 200; i++) {
    let best: GridPosition | null = null;
    let bestValue = Number.POSITIVE_INFINITY;
    for (const neighbor of getOpenNeighbors(current, grid)) {
      const value = g[indexOf(neighbor.x, neighbor.y, grid.nodesX)];
      if (value < bestValue) {
        bestValue = value;
        best = neighbor;
      }
    }
    if (!best) break;
    current = best;
    path.push(current);
    if (positionsEqual(current, goal)) break;
  }

  return path;
}

function simplifyPath(path: GridPosition[], grid: AdStarGrid): GridPosition[] {
  if (!path.length) return [];
  const simplified: GridPosition[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const last = simplified[simplified.length - 1];
    if (!walkable(last, path[i + 1], grid)) {
      simplified.push(path[i]);
    }
  }
  simplified.push(path[path.length - 1]);
  return simplified;
}

function walkable(a: GridPosition, b: GridPosition, grid: AdStarGrid): boolean {
  let x0 = a.x;
  let y0 = a.y;
  const x1 = b.x;
  const y1 = b.y;
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  let x = x0;
  let y = y0;
  let n = 1 + dx + dy;
  const xInc = x1 > x0 ? 1 : -1;
  const yInc = y1 > y0 ? 1 : -1;
  let error = dx - dy;
  dx *= 2;
  dy *= 2;

  while (n > 0) {
    if (isBlocked({ x, y }, grid)) {
      return false;
    }
    if (error > 0) {
      x += xInc;
      error -= dy;
    } else if (error < 0) {
      y += yInc;
      error += dx;
    } else {
      x += xInc;
      y += yInc;
      error -= dy;
      error += dx;
      n -= 1;
    }
    n -= 1;
  }

  return true;
}

function cost(a: GridPosition, b: GridPosition, grid: AdStarGrid): number {
  if (isCollision(a, b, grid)) return Number.POSITIVE_INFINITY;
  return heuristic(a, b);
}

function isCollision(a: GridPosition, b: GridPosition, grid: AdStarGrid): boolean {
  if (isBlocked(a, grid) || isBlocked(b, grid)) return true;
  if (a.x !== b.x && a.y !== b.y) {
    let s1: GridPosition;
    let s2: GridPosition;
    if (b.x - a.x === a.y - b.y) {
      s1 = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
      s2 = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
    } else {
      s1 = { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) };
      s2 = { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) };
    }
    return isBlocked(s1, grid) || isBlocked(s2, grid);
  }
  return false;
}

function getOpenNeighbors(pos: GridPosition, grid: AdStarGrid): GridPosition[] {
  const neighbors: GridPosition[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const next = { x: pos.x + dx, y: pos.y + dy };
      if (!isBlocked(next, grid)) {
        neighbors.push(next);
      }
    }
  }
  return neighbors;
}

function findClosestFree(start: GridPosition, grid: AdStarGrid): GridPosition | null {
  if (!isBlocked(start, grid)) return start;
  const visited = new Set<string>();
  const queue: GridPosition[] = getAllNeighbors(start, grid);
  while (queue.length) {
    const current = queue.shift()!;
    const key = `${current.x},${current.y}`;
    if (visited.has(key)) continue;
    if (!isBlocked(current, grid)) return current;
    visited.add(key);
    for (const neighbor of getAllNeighbors(current, grid)) {
      const nKey = `${neighbor.x},${neighbor.y}`;
      if (!visited.has(nKey)) {
        queue.push(neighbor);
      }
    }
  }
  return null;
}

function getAllNeighbors(pos: GridPosition, grid: AdStarGrid): GridPosition[] {
  const neighbors: GridPosition[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const next = { x: pos.x + dx, y: pos.y + dy };
      if (next.x >= 0 && next.x < grid.nodesX && next.y >= 0 && next.y < grid.nodesY) {
        neighbors.push(next);
      }
    }
  }
  return neighbors;
}

function getGridPos(pos: { x: number; y: number }, grid: AdStarGrid): GridPosition {
  return {
    x: Math.floor(pos.x / grid.nodeSizeCm),
    y: Math.floor(pos.y / grid.nodeSizeCm),
  };
}

function gridPosToPoint(pos: GridPosition, grid: AdStarGrid): { x: number; y: number } {
  return {
    x: (pos.x + 0.5) * grid.nodeSizeCm,
    y: (pos.y + 0.5) * grid.nodeSizeCm,
  };
}

function key(
  pos: GridPosition,
  start: GridPosition,
  g: Float64Array,
  rhs: Float64Array,
  eps: number,
  grid: AdStarGrid
): Pair {
  const idx = indexOf(pos.x, pos.y, grid.nodesX);
  if (g[idx] > rhs[idx]) {
    return [rhs[idx] + eps * heuristic(start, pos), rhs[idx]];
  }
  return [g[idx] + heuristic(start, pos), g[idx]];
}

function topKey(open: Map<number, Pair>): [number, Pair] | null {
  let best: [number, Pair] | null = null;
  for (const entry of open.entries()) {
    if (!best || comparePair(entry[1], best[1]) < 0) {
      best = entry;
    }
  }
  return best;
}

function heuristic(a: GridPosition, b: GridPosition): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function comparePair(a: Pair, b: Pair): number {
  if (a[0] === b[0]) return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  return a[0] < b[0] ? -1 : 1;
}

function positionsEqual(a: GridPosition, b: GridPosition): boolean {
  return a.x === b.x && a.y === b.y;
}

function isBlocked(pos: GridPosition, grid: AdStarGrid): boolean {
  if (pos.x < 0 || pos.x >= grid.nodesX || pos.y < 0 || pos.y >= grid.nodesY) {
    return true;
  }
  return grid.blocked[indexOf(pos.x, pos.y, grid.nodesX)] === 1;
}

function indexOf(x: number, y: number, nodesX: number): number {
  return y * nodesX + x;
}

function indexToPos(index: number, nodesX: number): GridPosition {
  return { x: index % nodesX, y: Math.floor(index / nodesX) };
}

type Pair = [number, number];
