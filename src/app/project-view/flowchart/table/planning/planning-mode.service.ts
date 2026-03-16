import { Injectable, computed, effect, inject, signal } from '@angular/core';

import { MissionStep } from '../../../../entities/MissionStep';
import { Pose2D, forwardMove } from '../models';
import {
  TableMapService,
  TableVisualizationService,
  type LineSegmentCm,
  type MapConfig,
  type RobotConfig,
  type WallSegmentCm,
} from '../services';
import { applyWallPhysicsToPath, buildCollisionWalls } from '../physics';
import {
  driveUntilColorFromStepId,
  isBackwardStepId,
  isDriveStepId,
  isFollowLineStepId,
  isLineupStepId,
  lineupColorFromStepId,
  lineupDirectionFromStepId,
  stepId,
} from '../step-id';
import {
  LineupSimulationContext,
  simulateBackwardLineupOnBlack,
  simulateBackwardLineupOnWhite,
  simulateDriveUntilColor,
  simulateFollowLine,
  simulateForwardLineupOnBlack,
  simulateForwardLineupOnWhite,
} from '../simulation-path';
import { DEFAULT_ASTAR_CONFIG, simulateCommand, type AStarConfig } from './pathfinding';
import { Waypoint, createWaypoint } from './models';
import { optimizeWaypointsToSteps, type OptimizationContext } from './path-optimizer';

const DEFAULT_FOLLOW_LINE_MAX_DISTANCE_CM = 300;

/**
 * Service for managing planning mode state.
 * Handles waypoints, path generation, and preview state.
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
  private readonly _allowStrafe = signal<boolean>(true);
  private readonly _generatedSteps = signal<MissionStep[]>([]);
  private readonly _isGenerating = signal<boolean>(false);

  private generationId = 0;
  private activeGenerationId = 0;
  private astarWorker: Worker | null = null;
  private lastGenerationInput: { wps: Waypoint[]; start: { x: number; y: number; theta: number }; threshold: number } | null = null;
  private generationTimer: ReturnType<typeof setTimeout> | null = null;
  private isDragging = false;
  private readonly generationDebounceMs = 150;

  readonly isActive = this._isActive.asReadonly();
  readonly waypoints = this._waypoints.asReadonly();
  readonly selectedIndex = this._selectedIndex.asReadonly();
  readonly draggingIndex = this._draggingIndex.asReadonly();
  readonly startPose = this._startPose.asReadonly();
  readonly lineupThreshold = this._lineupThreshold.asReadonly();
  readonly useAStarPathfinding = this._useAStarPathfinding.asReadonly();
  readonly allowStrafe = this._allowStrafe.asReadonly();
  readonly generatedSteps = this._generatedSteps.asReadonly();
  readonly isGenerating = this._isGenerating.asReadonly();

  constructor() {
    effect(() => {
      const wps = this._waypoints();
      const start = this._startPose();
      const threshold = this._lineupThreshold();
      const useAStar = this._useAStarPathfinding();
      const allowStrafe = this._allowStrafe();
      const wallSegments = this.mapService.wallSegmentsCm();
      const lineSegments = this.mapService.lineSegmentsCm();
      const mapConfig = this.mapService.config();
      const robotConfig = this.vizService.robotConfig();
      const sensorCount = this.vizService.sensorConfig().lineSensors.length;
      const draggingIndex = this._draggingIndex();

      if (draggingIndex !== null) {
        if (!this.isDragging) {
          this.isDragging = true;
          this.cancelGeneration();
        }
        return;
      }

      if (this.isDragging) {
        this.isDragging = false;
      }

      this.scheduleStepGeneration(
        wps,
        start,
        threshold,
        useAStar,
        allowStrafe,
        wallSegments,
        lineSegments,
        sensorCount,
        mapConfig,
        robotConfig
      );
    });
  }

  /** Computed: trajectory poses from generated steps, including wall physics. */
  readonly computedTrajectory = computed<Pose2D[]>(() => {
    const steps = this.generatedSteps();
    const start = this._startPose();
    if (steps.length === 0) return [];

    const rawPoses: Pose2D[] = [{ ...start }];
    let currentPose: Pose2D = { ...start };
    const lineupContext = this.buildLineupContext();

    for (const step of steps) {
      const id = stepId(step);
      const rawArg = step.arguments[0]?.value;
      const arg = typeof rawArg === 'number' ? rawArg : Number(rawArg ?? 0);

      const driveUntilColor = driveUntilColorFromStepId(id);
      if (driveUntilColor) {
        if (lineupContext) {
          const drivePoses = simulateDriveUntilColor(currentPose, lineupContext, driveUntilColor);
          if (drivePoses.length) {
            rawPoses.push(...drivePoses);
            currentPose = drivePoses[drivePoses.length - 1];
          }
        }
        continue;
      }

      if (isFollowLineStepId(id)) {
        const stopOnIntersection = arg <= 0;
        const maxDistance = lineupContext?.maxDistanceCm ?? DEFAULT_FOLLOW_LINE_MAX_DISTANCE_CM;
        const targetDistance = stopOnIntersection ? maxDistance : arg;
        if (targetDistance > 0) {
          if (lineupContext) {
            const followPoses = simulateFollowLine(currentPose, lineupContext, targetDistance, stopOnIntersection);
            if (followPoses.length) {
              rawPoses.push(...followPoses);
              currentPose = followPoses[followPoses.length - 1];
            } else if (!stopOnIntersection) {
              currentPose = forwardMove(currentPose, arg);
              rawPoses.push({ ...currentPose });
            }
          } else if (!stopOnIntersection) {
            currentPose = forwardMove(currentPose, arg);
            rawPoses.push({ ...currentPose });
          }
        }
        continue;
      }

      const lineupDirection = lineupDirectionFromStepId(id);
      const lineupColor = lineupColorFromStepId(id);
      if (lineupDirection && lineupColor && isLineupStepId(id)) {
        let lineupPoses: Pose2D[] = [];
        if (lineupContext) {
          if (lineupDirection === 'forward' && lineupColor === 'black') {
            lineupPoses = simulateForwardLineupOnBlack(currentPose, lineupContext);
          } else if (lineupDirection === 'forward' && lineupColor === 'white') {
            lineupPoses = simulateForwardLineupOnWhite(currentPose, lineupContext);
          } else if (lineupDirection === 'backward' && lineupColor === 'black') {
            lineupPoses = simulateBackwardLineupOnBlack(currentPose, lineupContext);
          } else if (lineupDirection === 'backward' && lineupColor === 'white') {
            lineupPoses = simulateBackwardLineupOnWhite(currentPose, lineupContext);
          }
        }
        if (lineupPoses.length) {
          rawPoses.push(...lineupPoses);
          currentPose = lineupPoses[lineupPoses.length - 1];
        }
        continue;
      }

      if (isDriveStepId(id)) {
        const distance = isBackwardStepId(id) ? -arg : arg;
        const numSteps = Math.max(1, Math.ceil(Math.abs(distance) / 2));
        const stepDistance = distance / numSteps;
        for (let i = 0; i < numSteps; i += 1) {
          currentPose = forwardMove(currentPose, stepDistance);
          rawPoses.push({ ...currentPose });
        }
        continue;
      }

      currentPose = simulateCommand(currentPose, step);
      rawPoses.push({ ...currentPose });
    }

    const walls = buildCollisionWalls(this.mapService.wallSegmentsCm(), this.mapService.config());
    return applyWallPhysicsToPath(rawPoses, this.vizService.robotConfig(), walls);
  });

  /** Computed: final pose after all generated steps. */
  readonly endPose = computed<Pose2D | null>(() => {
    const trajectory = this.computedTrajectory();
    return trajectory.length ? trajectory[trajectory.length - 1] : null;
  });

  /** Computed: whether we have enough waypoints to generate steps. */
  readonly canAddSteps = computed<boolean>(() => this._waypoints().length >= 1);

  /** Activate planning mode. */
  activate(): void {
    this._isActive.set(true);
  }

  /** Deactivate planning mode and clear state. */
  deactivate(): void {
    this._isActive.set(false);
    this.clear();
  }

  /** Toggle planning mode. */
  toggle(): void {
    if (this._isActive()) {
      this.deactivate();
    } else {
      this.activate();
    }
  }

  /** Set the planning start pose from the robot's current pose. */
  setStartPose(x: number, y: number, theta: number): void {
    this._startPose.set({ x, y, theta });
  }

  /** Set the lineup angle threshold (0 = permissive, 1 = strict). */
  setLineupThreshold(threshold: number): void {
    this._lineupThreshold.set(Math.max(0, Math.min(1, threshold)));
  }

  /** Enable or disable A* pathfinding. */
  setUseAStarPathfinding(enabled: boolean): void {
    this._useAStarPathfinding.set(enabled);
  }

  /** Enable or disable strafe commands in pathfinding. */
  setAllowStrafe(enabled: boolean): void {
    this._allowStrafe.set(enabled);
  }

  /** Add a waypoint at the given position. */
  addWaypoint(
    x: number,
    y: number,
    lineup = false,
    lineupLineIndex?: number,
    lineSnapAction?: 'lineup' | 'follow' | 'drive' | 'drive_until'
  ): void {
    const wp = createWaypoint(x, y, lineup, lineupLineIndex, lineSnapAction);
    this._waypoints.update(wps => [...wps, wp]);
    this._selectedIndex.set(this._waypoints().length - 1);
  }

  /** Remove waypoint at index. */
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

  /** Move waypoint at index to a new position. */
  moveWaypoint(
    index: number,
    x: number,
    y: number,
    lineup?: boolean,
    lineupLineIndex?: number,
    lineSnapAction?: 'lineup' | 'follow' | 'drive' | 'drive_until'
  ): void {
    this._waypoints.update(wps =>
      wps.map((wp, i) => {
        if (i !== index) return wp;
        const nextLineup = lineup ?? wp.lineup;
        const nextLineSnapAction = nextLineup ? (lineSnapAction ?? wp.lineSnapAction) : undefined;
        return {
          ...wp,
          x,
          y,
          lineup: nextLineup,
          lineupLineIndex: nextLineup ? (lineupLineIndex ?? wp.lineupLineIndex) : undefined,
          lineSnapAction: nextLineSnapAction,
        };
      })
    );
  }

  /** Clear lineup flags from all waypoints. */
  clearWaypointLineups(): void {
    this._waypoints.update(wps =>
      wps.map(wp => (wp.lineup ? { ...wp, lineup: false, lineupLineIndex: undefined, lineSnapAction: undefined } : wp))
    );
  }

  /** Select waypoint at index. */
  selectWaypoint(index: number | null): void {
    this._selectedIndex.set(index);
  }

  /** Start dragging waypoint at index. */
  startDragging(index: number): void {
    this._draggingIndex.set(index);
  }

  /** Stop dragging. */
  stopDragging(): void {
    this._draggingIndex.set(null);
  }

  /** Clear all waypoints and previews. */
  clear(): void {
    this.cancelGeneration();
    this._waypoints.set([]);
    this._selectedIndex.set(null);
    this._draggingIndex.set(null);
    this._generatedSteps.set([]);
  }

  /** Get generated steps and clear planner state. */
  consumeSteps(): MissionStep[] {
    const steps = this.generatedSteps();
    this.clear();
    return steps;
  }

  private scheduleStepGeneration(
    wps: Waypoint[],
    start: { x: number; y: number; theta: number },
    threshold: number,
    useAStar: boolean,
    allowStrafe: boolean,
    wallSegments: WallSegmentCm[],
    lineSegments: LineSegmentCm[],
    lineSensorCount: number,
    mapConfig: MapConfig,
    robotConfig: RobotConfig
  ): void {
    if (this.generationTimer) {
      clearTimeout(this.generationTimer);
    }

    this.generationTimer = setTimeout(() => {
      this.generationTimer = null;
      this.queueStepGeneration(
        wps,
        start,
        threshold,
        useAStar,
        allowStrafe,
        wallSegments,
        lineSegments,
        lineSensorCount,
        mapConfig,
        robotConfig
      );
    }, this.generationDebounceMs);
  }

  private cancelGeneration(): void {
    if (this.generationTimer) {
      clearTimeout(this.generationTimer);
      this.generationTimer = null;
    }
    this.activeGenerationId = ++this.generationId;
    this.stopAStarWorker();
    this._isGenerating.set(false);
  }

  private stopAStarWorker(): void {
    if (this.astarWorker) {
      this.astarWorker.terminate();
      this.astarWorker = null;
    }
  }

  private queueStepGeneration(
    wps: Waypoint[],
    start: { x: number; y: number; theta: number },
    threshold: number,
    useAStar: boolean,
    allowStrafe: boolean,
    wallSegments: WallSegmentCm[],
    lineSegments: LineSegmentCm[],
    lineSensorCount: number,
    mapConfig: MapConfig,
    robotConfig: RobotConfig
  ): void {
    const requestId = ++this.generationId;
    this.activeGenerationId = requestId;
    this.lastGenerationInput = { wps, start, threshold };

    if (wps.length < 1) {
      this._generatedSteps.set([]);
      this._isGenerating.set(false);
      return;
    }

    if (!useAStar) {
      this._isGenerating.set(false);
      this._generatedSteps.set(this.generateStepsDirectly(wps, start, threshold));
      return;
    }

    if (this._isGenerating()) {
      this.stopAStarWorker();
    }

    const worker = this.getAStarWorker();
    if (!worker) {
      this._isGenerating.set(false);
      this._generatedSteps.set(this.generateStepsDirectly(wps, start, threshold));
      return;
    }

    const walls = buildCollisionWalls(wallSegments, mapConfig);
    const tightConfig: AStarConfig = {
      ...DEFAULT_ASTAR_CONFIG,
      positionResolutionCm: 2,
      angleResolutionDeg: 5,
      goalToleranceCm: 3,
      maxIterations: DEFAULT_ASTAR_CONFIG.maxIterations * 2,
    };

    this._isGenerating.set(true);
    worker.postMessage({
      id: requestId,
      startPose: start,
      waypoints: wps.map(wp => ({
        x: wp.x,
        y: wp.y,
        lineup: !!wp.lineup,
        lineupLineIndex: wp.lineupLineIndex,
        lineSnapAction: wp.lineSnapAction,
      })),
      walls,
      robotConfig,
      mapConfig,
      config: DEFAULT_ASTAR_CONFIG,
      tightConfig,
      lineSegments,
      lineupThreshold: threshold,
      lineSensorCount,
      lineSensors: this.vizService.sensorConfig().lineSensors,
      rotationCenterForwardCm: this.vizService.robotConfig().rotationCenterForwardCm,
      rotationCenterStrafeCm: this.vizService.robotConfig().rotationCenterStrafeCm,
      allowStrafe,
    });
  }

  private getAStarWorker(): Worker | null {
    if (typeof Worker === 'undefined') return null;
    if (!this.astarWorker) {
      this.astarWorker = new Worker(
        new URL('./pathfinding/astar.worker', import.meta.url),
        { type: 'module' }
      );
      this.astarWorker.onmessage = (event: MessageEvent<{ id: number; steps: MissionStep[] }>) => {
        this.handleAStarWorkerMessage(event);
      };
      this.astarWorker.onerror = () => {
        this.handleAStarWorkerError();
      };
    }
    return this.astarWorker;
  }

  private handleAStarWorkerMessage(event: MessageEvent<{ id: number; steps: MissionStep[] }>): void {
    if (event.data.id !== this.activeGenerationId) {
      return;
    }
    this._generatedSteps.set(event.data.steps ?? []);
    this._isGenerating.set(false);
  }

  private handleAStarWorkerError(): void {
    if (!this._isGenerating()) return;
    const input = this.lastGenerationInput;
    if (input?.wps?.length) {
      this._generatedSteps.set(this.generateStepsDirectly(input.wps, input.start, input.threshold));
    }
    this._isGenerating.set(false);
  }

  private generateStepsDirectly(
    wps: Waypoint[],
    start: { x: number; y: number; theta: number },
    threshold: number
  ): MissionStep[] {
    const fullPath: Waypoint[] = [
      { id: 'start', x: start.x, y: start.y, lineup: false, lineupLineIndex: undefined, lineSnapAction: undefined },
      ...wps,
    ];

    const robotConfig = this.vizService.robotConfig();
    const mapConfig = this.mapService.config();
    const context: OptimizationContext = {
      lineSegments: this.mapService.lineSegmentsCm(),
      sensorConfig: this.vizService.sensorConfig(),
      isOnBlackLine: (x, y) => this.mapService.isOnBlackLine(x, y),
      rotationCenterForwardCm: robotConfig.rotationCenterForwardCm,
      rotationCenterStrafeCm: robotConfig.rotationCenterStrafeCm,
      maxLineupDistanceCm: Math.max(mapConfig.widthCm, mapConfig.heightCm),
    };

    return optimizeWaypointsToSteps(
      fullPath,
      { x: start.x, y: start.y, theta: start.theta },
      context,
      { lineupThreshold: threshold }
    );
  }

  private buildLineupContext(): LineupSimulationContext | null {
    if (!this.mapService.isLoaded()) return null;

    const sensorConfig = this.vizService.sensorConfig();
    if (sensorConfig.lineSensors.length === 0) return null;

    const robotConfig = this.vizService.robotConfig();
    const mapConfig = this.mapService.config();
    return {
      isOnBlackLine: (x, y) => this.mapService.isOnBlackLine(x, y),
      lineSensors: sensorConfig.lineSensors,
      rotationCenterForwardCm: robotConfig.rotationCenterForwardCm,
      rotationCenterStrafeCm: robotConfig.rotationCenterStrafeCm,
      maxDistanceCm: Math.max(mapConfig.widthCm, mapConfig.heightCm),
    };
  }
}
