import { Pose2D, normalizeAngle } from '../../models';
import { MissionStep } from '../../../../../entities/MissionStep';
import { RobotConfig } from '../../services';
import { MapConfig } from '../../services';
import { WallSegment, checkPathCollision, checkRobotCollision, isRobotInBounds } from '../../physics';
import { simulateCommand } from './pose-simulator';
import {
  FlowStepId,
  isDriveOrStrafeStepId,
  isDriveStepId,
  isStrafeStepId,
  isTurnStepId,
  stepId,
} from '../../step-id';

// --- Configuration ---

export interface AStarConfig {
  /** Position discretization in cm (for visited state detection) */
  positionResolutionCm: number;
  /** Angle discretization in degrees (for visited state detection) */
  angleResolutionDeg: number;
  /** Goal tolerance in cm (how close is "at goal") */
  goalToleranceCm: number;
  /** Maximum iterations before giving up */
  maxIterations: number;
}

export const DEFAULT_ASTAR_CONFIG: AStarConfig = {
  positionResolutionCm: 5,
  angleResolutionDeg: 15,
  goalToleranceCm: 5,
  maxIterations: 50000,
};

const TURN_CLEARANCE_CM = 1;

// --- Command Generation ---

function createDriveStep(distanceCm: number): MissionStep {
  return {
    step_type: FlowStepId.DriveForward,
    function_name: FlowStepId.DriveForward,
    arguments: [{ name: 'cm', value: distanceCm, type: 'float' }],
    position: { x: 0, y: 0 },
    children: [],
  };
}

function createReverseStep(distanceCm: number): MissionStep {
  return {
    step_type: FlowStepId.DriveBackward,
    function_name: FlowStepId.DriveBackward,
    arguments: [{ name: 'cm', value: distanceCm, type: 'float' }],
    position: { x: 0, y: 0 },
    children: [],
  };
}

function createTurnStep(angleDeg: number): MissionStep {
  const isClockwise = angleDeg < 0;
  const functionName = isClockwise ? FlowStepId.TurnCw : FlowStepId.TurnCcw;
  return {
    step_type: functionName,
    function_name: functionName,
    arguments: [{ name: 'deg', value: Math.abs(angleDeg), type: 'float' }],
    position: { x: 0, y: 0 },
    children: [],
  };
}

function createStrafeStep(direction: 'left' | 'right', distanceCm: number): MissionStep {
  const functionName = direction === 'left' ? FlowStepId.StrafeLeft : FlowStepId.StrafeRight;
  return {
    step_type: functionName,
    function_name: functionName,
    arguments: [{ name: 'cm', value: distanceCm, type: 'float' }],
    position: { x: 0, y: 0 },
    children: [],
  };
}

/** Available commands for A* exploration */
const AVAILABLE_COMMANDS: MissionStep[] = [
  // Drive commands (smaller steps help in tight spaces)
  createDriveStep(2),
  createDriveStep(5),
  createDriveStep(10),
  createDriveStep(20),
  createReverseStep(2),
  createReverseStep(5),
  createReverseStep(10),
  createReverseStep(20),
  // Strafe commands
  createStrafeStep('left', 2),
  createStrafeStep('left', 5),
  createStrafeStep('left', 10),
  createStrafeStep('right', 2),
  createStrafeStep('right', 5),
  createStrafeStep('right', 10),
  // Turn commands (clockwise)
  createTurnStep(-5),
  createTurnStep(-15),
  createTurnStep(-45),
  createTurnStep(-90),
  // Turn commands (counter-clockwise)
  createTurnStep(5),
  createTurnStep(15),
  createTurnStep(45),
  createTurnStep(90),
];

const STRAFE_COMMANDS = new Set<string>([FlowStepId.StrafeLeft, FlowStepId.StrafeRight]);
const AVAILABLE_COMMANDS_NO_STRAFE = AVAILABLE_COMMANDS.filter(
  command => !STRAFE_COMMANDS.has(stepId(command))
);

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

function inflateRobotConfig(robotConfig: RobotConfig, clearanceCm: number): RobotConfig {
  if (clearanceCm <= 0) return robotConfig;
  return {
    ...robotConfig,
    widthCm: robotConfig.widthCm + clearanceCm * 2,
    lengthCm: robotConfig.lengthCm + clearanceCm * 2,
  };
}

// --- A* Node ---

interface AStarNode {
  pose: Pose2D;
  g: number;  // Cost from start
  h: number;  // Heuristic to goal
  f: number;  // Total cost (g + h)
  parent: AStarNode | null;
  command: MissionStep | null;  // Command that led to this node
}

// --- Min Heap Implementation ---

class MinHeap {
  private heap: AStarNode[] = [];

  push(node: AStarNode): void {
    this.heap.push(node);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): AStarNode | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();

    const min = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);
    return min;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  size(): number {
    return this.heap.length;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.heap[parentIndex].f <= this.heap[index].f) break;
      [this.heap[parentIndex], this.heap[index]] = [this.heap[index], this.heap[parentIndex]];
      index = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (leftChild < length && this.heap[leftChild].f < this.heap[smallest].f) {
        smallest = leftChild;
      }
      if (rightChild < length && this.heap[rightChild].f < this.heap[smallest].f) {
        smallest = rightChild;
      }
      if (smallest === index) break;

      [this.heap[smallest], this.heap[index]] = [this.heap[index], this.heap[smallest]];
      index = smallest;
    }
  }
}

// --- Helper Functions ---

/**
 * Convert pose to a discretized state key for visited set.
 */
function poseToStateKey(pose: Pose2D, config: AStarConfig): string {
  const x = Math.round(pose.x / config.positionResolutionCm) * config.positionResolutionCm;
  const y = Math.round(pose.y / config.positionResolutionCm) * config.positionResolutionCm;
  const thetaDeg = pose.theta * 180 / Math.PI;
  const theta = Math.round(thetaDeg / config.angleResolutionDeg) * config.angleResolutionDeg;
  return `${x},${y},${theta}`;
}

/**
 * Check if pose is at the goal (within tolerance).
 */
function isAtGoal(pose: Pose2D, goal: { x: number; y: number }, toleranceCm: number): boolean {
  const dx = pose.x - goal.x;
  const dy = pose.y - goal.y;
  return Math.sqrt(dx * dx + dy * dy) <= toleranceCm;
}

/**
 * Calculate the cost of executing a command.
 */
function calculateCost(command: MissionStep): number {
  const fn = stepId(command);
  const arg = (command.arguments[0]?.value as number) ?? 0;

  if (isDriveOrStrafeStepId(fn)) {
    // Cost proportional to distance (0.1 per cm)
    return arg * 0.1;
  }
  if (isTurnStepId(fn)) {
    // Cost proportional to angle (0.02 per degree)
    // Turns are relatively cheap to encourage proper facing
    return arg * 0.02;
  }
  return 1;
}

/**
 * Heuristic function: estimated cost to reach goal.
 * Uses Euclidean distance scaled by typical cost.
 */
function heuristic(pose: Pose2D, goal: { x: number; y: number }): number {
  const dx = goal.x - pose.x;
  const dy = goal.y - pose.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Estimate: need to turn to face goal, then drive
  // Assume average turn cost is small relative to drive
  return distance * 0.1;
}

/**
 * Reconstruct the path from start to goal.
 */
function reconstructPath(node: AStarNode): { commands: MissionStep[]; finalPose: Pose2D } {
  const commands: MissionStep[] = [];
  let current: AStarNode | null = node;

  while (current?.parent) {
    if (current.command) {
      commands.unshift(current.command);
    }
    current = current.parent;
  }

  return { commands, finalPose: node.pose };
}

// --- Main A* Algorithm ---

export interface FindPathResult {
  commands: MissionStep[];
  finalPose: Pose2D;
  nodesExplored: number;
}

/**
 * Find a path from start pose to goal position using command-based A*.
 *
 * @param startPose - Starting robot pose
 * @param goal - Goal position (x, y) in cm
 * @param walls - Wall segments to avoid
 * @param robotConfig - Robot dimensions
 * @param mapConfig - Map dimensions
 * @param config - A* configuration
 * @returns Path result or null if no path found
 */
export function findPath(
  startPose: Pose2D,
  goal: { x: number; y: number },
  walls: WallSegment[],
  robotConfig: RobotConfig,
  mapConfig: MapConfig,
  config: AStarConfig = DEFAULT_ASTAR_CONFIG,
  options?: { allowStrafe?: boolean }
): FindPathResult | null {
  const allowStrafe = options?.allowStrafe ?? true;
  const availableCommands = allowStrafe ? AVAILABLE_COMMANDS : AVAILABLE_COMMANDS_NO_STRAFE;
  console.log('[A*] findPath called:', {
    startPose,
    goal,
    wallCount: walls.length,
    robotConfig,
    mapConfig: { widthCm: mapConfig.widthCm, heightCm: mapConfig.heightCm },
    allowStrafe,
  });

  const rotationConfig = inflateRobotConfig(robotConfig, TURN_CLEARANCE_CM);

  // Check if already at goal
  if (isAtGoal(startPose, goal, config.goalToleranceCm)) {
    console.log('[A*] Already at goal');
    return { commands: [], finalPose: startPose, nodesExplored: 0 };
  }

  const openSet = new MinHeap();
  const visited = new Set<string>();

  // Initialize with start node
  const startNode: AStarNode = {
    pose: startPose,
    g: 0,
    h: heuristic(startPose, goal),
    f: heuristic(startPose, goal),
    parent: null,
    command: null,
  };
  openSet.push(startNode);

  let iterations = 0;

  while (!openSet.isEmpty() && iterations < config.maxIterations) {
    iterations++;
    const current = openSet.pop()!;

    // Check if we've reached the goal
    if (isAtGoal(current.pose, goal, config.goalToleranceCm)) {
      console.log('[A*] Path found! Iterations:', iterations);
      return { ...reconstructPath(current), nodesExplored: iterations };
    }

    // Mark as visited
    const stateKey = poseToStateKey(current.pose, config);
    if (visited.has(stateKey)) continue;
    visited.add(stateKey);

    // Explore all available commands
    for (const command of availableCommands) {
      const newPose = simulateCommand(current.pose, command);
      const fn = stepId(command);
      const arg = (command.arguments[0]?.value as number) ?? 0;
      const steps = Math.max(5, Math.ceil(Math.abs(arg) / 2));
      const isTurn = isTurnStepId(fn);

      if (!isRobotInBounds(newPose, mapConfig, robotConfig)) continue;
      if (isTurn) {
        const angleSteps = Math.max(6, Math.ceil(Math.abs(arg) / 5));
        if (checkRotationCollision(current.pose, newPose, rotationConfig, walls, angleSteps)) continue;
      } else {
        const startCollides = checkRobotCollision(current.pose, robotConfig, walls);
        const blocked = startCollides
          ? checkPathCollisionExcludingStart(current.pose, newPose, robotConfig, walls, steps)
          : checkPathCollision(current.pose, newPose, robotConfig, walls, steps);
        if (blocked) continue;
      }

      // Skip if already visited (at discretized level)
      const newStateKey = poseToStateKey(newPose, config);
      if (visited.has(newStateKey)) continue;

      // Skip if we didn't move at all (stuck against wall)
      const dx = newPose.x - current.pose.x;
      const dy = newPose.y - current.pose.y;
      const dTheta = Math.abs(normalizeAngle(newPose.theta - current.pose.theta));
      const movedDistance = Math.sqrt(dx * dx + dy * dy);
      if (movedDistance < 0.5 && dTheta < 0.01) continue;

      // Calculate costs
      const g = current.g + calculateCost(command);
      const h = heuristic(newPose, goal);
      const f = g + h;

      const newNode: AStarNode = {
        pose: newPose,
        g,
        h,
        f,
        parent: current,
        command,
      };

      openSet.push(newNode);
    }
  }

  console.warn(`A* pathfinding: No path found after ${iterations} iterations`);
  return null;
}

/**
 * Optimize the resulting path by merging consecutive same-type commands.
 * E.g., [drive(5), drive(10)] -> [drive(15)]
 */
export function optimizePath(result: FindPathResult): FindPathResult {
  if (result.commands.length <= 1) return result;

  const optimized: MissionStep[] = [];
  let i = 0;

  while (i < result.commands.length) {
    const current = result.commands[i];
    const fn = stepId(current);

    // Try to merge consecutive same commands
    if (isDriveStepId(fn)) {
      let totalDistance = (current.arguments[0]?.value as number) ?? 0;
      let j = i + 1;

      while (j < result.commands.length && stepId(result.commands[j]) === fn) {
        totalDistance += (result.commands[j].arguments[0]?.value as number) ?? 0;
        j++;
      }

      optimized.push({
        ...current,
        arguments: [{ name: 'cm', value: totalDistance, type: 'float' }],
      });
      i = j;
    } else if (isStrafeStepId(fn)) {
      let totalDistance = (current.arguments[0]?.value as number) ?? 0;
      let j = i + 1;

      while (j < result.commands.length && stepId(result.commands[j]) === fn) {
        totalDistance += (result.commands[j].arguments[0]?.value as number) ?? 0;
        j++;
      }

      optimized.push({
        ...current,
        arguments: [{ name: 'cm', value: totalDistance, type: 'float' }],
      });
      i = j;
    } else if (isTurnStepId(fn)) {
      // Merge same-direction turns
      let totalAngle = (current.arguments[0]?.value as number) ?? 0;
      let j = i + 1;

      while (j < result.commands.length && stepId(result.commands[j]) === fn) {
        totalAngle += (result.commands[j].arguments[0]?.value as number) ?? 0;
        j++;
      }

      // Normalize angle (shouldn't exceed 360)
      totalAngle = totalAngle % 360;
      if (totalAngle > 0) {
        optimized.push({
          ...current,
          arguments: [{ name: 'deg', value: totalAngle, type: 'float' }],
        });
      }
      i = j;
    } else {
      optimized.push(current);
      i++;
    }
  }

  return { ...result, commands: optimized };
}
