import { Injectable, inject, signal, computed } from '@angular/core';
import { Waypoint, createWaypoint } from './models';
import { MissionStep } from '../../../../entities/MissionStep';
import { optimizeWaypointsToSteps, OptimizationContext } from './path-optimizer';
import { TableMapService, TableVisualizationService, type MapConfig, type RobotConfig } from '../services';
import {
  buildCollisionWalls,
  applyWallPhysicsToPath,
  applyWallPhysicsToPathWithSegments,
  checkRobotCollision,
  isRobotInBounds,
  type WallSegment,
} from '../physics';
import {
  findPath,
  optimizePath,
  DEFAULT_ASTAR_CONFIG,
  simulateCommand,
  getCommandTrajectory,
} from './pathfinding';
import { Pose2D } from '../models';

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

    for (const wp of wps) {
      const result = findPath(
        currentPose,
        { x: wp.x, y: wp.y },
        walls,
        robotConfig,
        mapConfig,
        DEFAULT_ASTAR_CONFIG
      );

      if (!result) {
        console.warn(`A* pathfinding failed for waypoint (${wp.x}, ${wp.y}), using direct path`);
        const directSteps = this.generateStepsDirectly(
          [wp],
          { x: currentPose.x, y: currentPose.y, theta: currentPose.theta },
          0
        );
        allSteps.push(...directSteps);
        currentPose = this.simulateFinalPose(currentPose, directSteps);
      } else {
        const optimized = optimizePath(result);
        const validation = this.validateAStarPath(
          optimized.commands,
          currentPose,
          { x: wp.x, y: wp.y },
          walls,
          robotConfig,
          mapConfig,
          DEFAULT_ASTAR_CONFIG.goalToleranceCm
        );

        if (!validation.ok) {
          console.warn(`A* validation failed for waypoint (${wp.x}, ${wp.y}), using direct path`);
          const directSteps = this.generateStepsDirectly(
            [wp],
            { x: currentPose.x, y: currentPose.y, theta: currentPose.theta },
            0
          );
          allSteps.push(...directSteps);
          currentPose = this.simulateFinalPose(currentPose, directSteps);
        } else {
          allSteps.push(...optimized.commands);
          currentPose = validation.finalPose;
        }
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
    const rawTrajectory = getCommandTrajectory(startPose, commands);
    if (rawTrajectory.length === 0) {
      return { ok: false, finalPose: startPose };
    }

    const adjusted = applyWallPhysicsToPathWithSegments(rawTrajectory, robotConfig, walls);
    if (!adjusted.poses.length) {
      return { ok: false, finalPose: startPose };
    }

    const finalPose = adjusted.poses[adjusted.poses.length - 1];
    const dx = finalPose.x - goal.x;
    const dy = finalPose.y - goal.y;
    const distanceToGoal = Math.sqrt(dx * dx + dy * dy);
    if (distanceToGoal > goalToleranceCm) {
      return { ok: false, finalPose };
    }

    let prevPose = adjusted.poses[0];
    for (const pose of adjusted.poses) {
      if (!isRobotInBounds(pose, mapConfig, robotConfig)) {
        return { ok: false, finalPose };
      }

      const dx = pose.x - prevPose.x;
      const dy = pose.y - prevPose.y;
      const movedDistance = Math.sqrt(dx * dx + dy * dy);
      if (movedDistance >= 0.01 && checkRobotCollision(pose, robotConfig, walls)) {
        return { ok: false, finalPose };
      }

      prevPose = pose;
    }

    return { ok: true, finalPose };
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
