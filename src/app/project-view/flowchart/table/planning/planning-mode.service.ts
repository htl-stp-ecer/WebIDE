import { Injectable, inject, signal, computed } from '@angular/core';
import { Waypoint, createWaypoint } from './models';
import { MissionStep } from '../../../../entities/MissionStep';
import { optimizeWaypointsToSteps, OptimizationContext } from './path-optimizer';
import { TableMapService, TableVisualizationService, type MapConfig, type RobotConfig } from '../services';
import {
  buildCollisionWalls,
  applyWallPhysicsToPath,
  checkPathCollision,
  checkRobotCollision,
  isRobotInBounds,
  type WallSegment,
} from '../physics';
import {
  findPath,
  optimizePath,
  DEFAULT_ASTAR_CONFIG,
  simulateCommand,
  type AStarConfig,
} from './pathfinding';
import { Pose2D, normalizeAngle } from '../models';

/**
 * Service for managing planning mode state.
 * Handles waypoints, step generation, and UI state.
 */
@Injectable({ providedIn: 'root' })
export class PlanningModeService {
  private readonly mapService = inject(TableMapService);
  private readonly vizService = inject(TableVisualizationService);

  private readonly _isActive = signal<boolean>(false);
  private readonly _waypoints = signal<Waypoint[]>([]);
  private readonly _selectedIndex = signal<number | null>(null);
  private readonly _draggingIndex = signal<number | null>(null);
  private readonly _startPose = signal<{ x: number; y: number; theta: number }>({ x: 0, y: 0, theta: 0 });
  private readonly _lineupThreshold = signal<number>(0.5);
  private readonly _useAStarPathfinding = signal<boolean>(true);

  readonly isActive = this._isActive.asReadonly();
  readonly waypoints = this._waypoints.asReadonly();
  readonly selectedIndex = this._selectedIndex.asReadonly();
  readonly draggingIndex = this._draggingIndex.asReadonly();
  readonly startPose = this._startPose.asReadonly();
  readonly lineupThreshold = this._lineupThreshold.asReadonly();
  readonly useAStarPathfinding = this._useAStarPathfinding.asReadonly();

  /** Computed: generated mission steps from current waypoints (with A* pathfinding or direct optimization) */
  readonly generatedSteps = computed<MissionStep[]>(() => {
    const wps = this._waypoints();
    const start = this._startPose();
    const threshold = this._lineupThreshold();
    const useAStar = this._useAStarPathfinding();
    if (wps.length < 1) return [];

    if (useAStar) {
      return this.generateStepsWithAStar(wps, start);
    }

    return this.generateStepsDirectly(wps, start, threshold);
  });

  /**
   * Generate steps using A* pathfinding algorithm.
   * Finds collision-free paths around obstacles.
   */
  private generateStepsWithAStar(
    wps: Waypoint[],
    start: { x: number; y: number; theta: number }
  ): MissionStep[] {
    const wallSegments = this.mapService.wallSegmentsCm();
    const mapConfig = this.mapService.config();
    const walls = buildCollisionWalls(wallSegments, mapConfig);
    const robotConfig = this.vizService.robotConfig();

    console.log('[A*] Wall segments from map:', wallSegments.length);
    console.log('[A*] Total walls (incl. boundaries):', walls.length);
    console.log('[A*] Map config:', mapConfig);
    console.log('[A*] Robot config:', robotConfig);

    const allSteps: MissionStep[] = [];
    let currentPose: Pose2D = { x: start.x, y: start.y, theta: start.theta };

    const tightConfig: AStarConfig = {
      ...DEFAULT_ASTAR_CONFIG,
      positionResolutionCm: 2,
      angleResolutionDeg: 5,
      goalToleranceCm: 3,
      maxIterations: DEFAULT_ASTAR_CONFIG.maxIterations * 2,
    };

    for (const wp of wps) {
      const goal = { x: wp.x, y: wp.y };
      const primary = this.findValidatedAStarPath(
        currentPose,
        goal,
        walls,
        robotConfig,
        mapConfig,
        DEFAULT_ASTAR_CONFIG
      );
      const candidate = primary ?? this.findValidatedAStarPath(
        currentPose,
        goal,
        walls,
        robotConfig,
        mapConfig,
        tightConfig
      );

      if (!candidate) {
        console.warn(`A* pathfinding failed for waypoint (${wp.x}, ${wp.y}), using direct path`);
        const directSteps = this.generateStepsDirectly(
          [wp],
          { x: currentPose.x, y: currentPose.y, theta: currentPose.theta },
          0
        );
        allSteps.push(...directSteps);
        currentPose = this.simulateFinalPose(currentPose, directSteps);
      } else {
        allSteps.push(...candidate.commands);
        currentPose = candidate.finalPose;
      }
    }

    return allSteps;
  }

  /**
   * Generate steps using direct waypoint-to-steps conversion (original behavior).
   */
  private generateStepsDirectly(
    wps: Waypoint[],
    start: { x: number; y: number; theta: number },
    threshold: number
  ): MissionStep[] {
    // Include robot start position as first waypoint for path calculation
    const fullPath: Waypoint[] = [
      { id: 'start', x: start.x, y: start.y },
      ...wps,
    ];

    const context: OptimizationContext = {
      lineSegments: this.mapService.lineSegmentsCm(),
      sensorConfig: this.vizService.sensorConfig(),
      isOnBlackLine: (x, y) => this.mapService.isOnBlackLine(x, y),
    };

    return optimizeWaypointsToSteps(
      fullPath,
      { x: start.x, y: start.y, theta: start.theta },
      context,
      { lineupThreshold: threshold }
    );
  }

  private findValidatedAStarPath(
    startPose: Pose2D,
    goal: { x: number; y: number },
    walls: WallSegment[],
    robotConfig: RobotConfig,
    mapConfig: MapConfig,
    config: AStarConfig
  ): { commands: MissionStep[]; finalPose: Pose2D } | null {
    const result = findPath(
      startPose,
      goal,
      walls,
      robotConfig,
      mapConfig,
      config
    );
    if (!result) return null;

    const optimized = optimizePath(result);
    const validation = this.validateAStarPath(
      optimized.commands,
      startPose,
      goal,
      walls,
      robotConfig,
      mapConfig,
      config.goalToleranceCm
    );

    if (!validation.ok) {
      console.warn(`A* validation failed for waypoint (${goal.x}, ${goal.y})`);
      return null;
    }

    return { commands: optimized.commands, finalPose: validation.finalPose };
  }

  /**
   * Simulate the final pose after executing a sequence of steps.
   */
  private simulateFinalPose(startPose: Pose2D, steps: MissionStep[]): Pose2D {
    let pose = startPose;
    for (const step of steps) {
      const fn = step.function_name;
      const arg = (step.arguments[0]?.value as number) ?? 0;

      if (fn === 'drive_forward') {
        pose = {
          x: pose.x + arg * Math.cos(pose.theta),
          y: pose.y + arg * Math.sin(pose.theta),
          theta: pose.theta,
        };
      } else if (fn === 'turn_cw') {
        pose = { ...pose, theta: pose.theta - arg * Math.PI / 180 };
      } else if (fn === 'turn_ccw') {
        pose = { ...pose, theta: pose.theta + arg * Math.PI / 180 };
      }
    }
    return pose;
  }

  private validateAStarPath(
    commands: MissionStep[],
    startPose: Pose2D,
    goal: { x: number; y: number },
    walls: WallSegment[],
    robotConfig: RobotConfig,
    mapConfig: MapConfig,
    goalToleranceCm: number
  ): { ok: boolean; finalPose: Pose2D } {
    if (!commands.length) {
      return { ok: false, finalPose: startPose };
    }

    let pose = startPose;
    for (const command of commands) {
      const nextPose = simulateCommand(pose, command);
      if (!isRobotInBounds(nextPose, mapConfig, robotConfig)) {
        return { ok: false, finalPose: nextPose };
      }

      const fn = command.function_name;
      const arg = (command.arguments[0]?.value as number) ?? 0;
      const isTurn = fn === 'turn_cw' || fn === 'turn_ccw' || fn === 'tank_turn_cw' || fn === 'tank_turn_ccw';

      if (isTurn) {
        const angleSteps = Math.max(6, Math.ceil(Math.abs(arg) / 5));
        if (this.checkRotationCollision(pose, nextPose, robotConfig, walls, angleSteps)) {
          return { ok: false, finalPose: nextPose };
        }
      } else {
        const steps = Math.max(5, Math.ceil(Math.abs(arg) / 2));
        const startCollides = checkRobotCollision(pose, robotConfig, walls);
        const blocked = startCollides
          ? this.checkPathCollisionExcludingStart(pose, nextPose, robotConfig, walls, steps)
          : checkPathCollision(pose, nextPose, robotConfig, walls, steps);
        if (blocked) {
          return { ok: false, finalPose: nextPose };
        }
      }

      pose = nextPose;
    }

    const dx = pose.x - goal.x;
    const dy = pose.y - goal.y;
    const distanceToGoal = Math.sqrt(dx * dx + dy * dy);
    if (distanceToGoal > goalToleranceCm) {
      return { ok: false, finalPose: pose };
    }

    return { ok: true, finalPose: pose };
  }

  private checkPathCollisionExcludingStart(
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

  private checkRotationCollision(
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

  /** Computed: trajectory poses from the generated steps (with wall physics) */
  readonly computedTrajectory = computed<Pose2D[]>(() => {
    const steps = this.generatedSteps();
    const start = this._startPose();
    if (steps.length === 0) return [];

    // First, compute the raw trajectory from commands
    const rawPoses: Pose2D[] = [];
    let currentPose: Pose2D = { x: start.x, y: start.y, theta: start.theta };
    rawPoses.push({ ...currentPose });

    for (const step of steps) {
      // For drive commands, add intermediate poses for smooth visualization
      const fn = step.function_name;
      const arg = (step.arguments[0]?.value as number) ?? 0;

      if (fn === 'drive_forward' || fn === 'drive_backward') {
        // Add intermediate points every 2cm for smooth path and accurate physics
        const distance = fn === 'drive_backward' ? -arg : arg;
        const numSteps = Math.max(1, Math.ceil(Math.abs(distance) / 2));
        const stepDist = distance / numSteps;

        for (let i = 0; i < numSteps; i++) {
          currentPose = {
            x: currentPose.x + stepDist * Math.cos(currentPose.theta),
            y: currentPose.y + stepDist * Math.sin(currentPose.theta),
            theta: currentPose.theta,
          };
          rawPoses.push({ ...currentPose });
        }
      } else {
        // For turns and other commands, just compute the final pose
        currentPose = simulateCommand(currentPose, step);
        rawPoses.push({ ...currentPose });
      }
    }

    // Apply wall physics to get the actual trajectory with wall sliding
    const wallSegments = this.mapService.wallSegmentsCm();
    const mapConfig = this.mapService.config();
    const walls = buildCollisionWalls(wallSegments, mapConfig);
    const robotConfig = this.vizService.robotConfig();

    return applyWallPhysicsToPath(rawPoses, robotConfig, walls);
  });

  /** Computed: final pose after all steps */
  readonly endPose = computed<Pose2D | null>(() => {
    const trajectory = this.computedTrajectory();
    if (trajectory.length === 0) return null;
    return trajectory[trajectory.length - 1];
  });

  /** Computed: whether we have enough waypoints to generate steps */
  readonly canAddSteps = computed<boolean>(() => {
    return this._waypoints().length >= 1;
  });

  /** Activate planning mode */
  activate(): void {
    this._isActive.set(true);
  }

  /** Deactivate planning mode and clear state */
  deactivate(): void {
    this._isActive.set(false);
    this.clear();
  }

  /** Toggle planning mode */
  toggle(): void {
    if (this._isActive()) {
      this.deactivate();
    } else {
      this.activate();
    }
  }

  /** Set the start pose (from robot's current pose) */
  setStartPose(x: number, y: number, theta: number): void {
    this._startPose.set({ x, y, theta });
  }

  /** Set the lineup angle threshold (0 = permissive, 1 = strict) */
  setLineupThreshold(threshold: number): void {
    this._lineupThreshold.set(Math.max(0, Math.min(1, threshold)));
  }

  /** Enable or disable A* pathfinding */
  setUseAStarPathfinding(enabled: boolean): void {
    this._useAStarPathfinding.set(enabled);
  }

  /** Toggle A* pathfinding on/off */
  toggleAStarPathfinding(): void {
    this._useAStarPathfinding.update(v => !v);
  }

  /** Add a waypoint at the given position */
  addWaypoint(x: number, y: number): void {
    const wp = createWaypoint(x, y);
    this._waypoints.update(wps => [...wps, wp]);
    this._selectedIndex.set(this._waypoints().length - 1);
  }

  /** Remove waypoint at index */
  removeWaypoint(index: number): void {
    this._waypoints.update(wps => wps.filter((_, i) => i !== index));
    const selected = this._selectedIndex();
    if (selected !== null) {
      if (selected === index) {
        this._selectedIndex.set(null);
      } else if (selected > index) {
        this._selectedIndex.set(selected - 1);
      }
    }
  }

  /** Move waypoint at index to new position */
  moveWaypoint(index: number, x: number, y: number): void {
    this._waypoints.update(wps =>
      wps.map((wp, i) => (i === index ? { ...wp, x, y } : wp))
    );
  }

  /** Select waypoint at index */
  selectWaypoint(index: number | null): void {
    this._selectedIndex.set(index);
  }

  /** Start dragging waypoint at index */
  startDragging(index: number): void {
    this._draggingIndex.set(index);
  }

  /** Stop dragging */
  stopDragging(): void {
    this._draggingIndex.set(null);
  }

  /** Clear all waypoints */
  clear(): void {
    this._waypoints.set([]);
    this._selectedIndex.set(null);
    this._draggingIndex.set(null);
  }

  /** Get the generated steps and clear state (for adding to mission) */
  consumeSteps(): MissionStep[] {
    const steps = this.generatedSteps();
    this.clear();
    return steps;
  }
}
