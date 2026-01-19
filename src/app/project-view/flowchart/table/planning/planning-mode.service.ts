import { Injectable, inject, signal, computed, effect } from '@angular/core';
import { Waypoint, createWaypoint } from './models';
import { MissionStep } from '../../../../entities/MissionStep';
import { optimizeWaypointsToSteps, OptimizationContext } from './path-optimizer';
import {
  TableMapService,
  TableVisualizationService,
  type LineSegmentCm,
  type MapConfig,
  type RobotConfig,
  type WallSegmentCm,
} from '../services';
import {
  buildCollisionWalls,
  applyWallPhysicsToPath,
} from '../physics';
import {
  DEFAULT_ASTAR_CONFIG,
  simulateCommand,
  type AStarConfig,
} from './pathfinding';
import {
  LineupSimulationContext,
  simulateBackwardLineupOnBlack,
  simulateBackwardLineupOnWhite,
  simulateDriveUntilColor,
  simulateForwardLineupOnBlack,
  simulateForwardLineupOnWhite,
} from '../simulation-path';
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
  readonly generatedSteps = this._generatedSteps.asReadonly();
  readonly isGenerating = this._isGenerating.asReadonly();

  constructor() {
    effect(() => {
      const wps = this._waypoints();
      const start = this._startPose();
      const threshold = this._lineupThreshold();
      const useAStar = this._useAStarPathfinding();
      const wallSegments = this.mapService.wallSegmentsCm();
      const lineSegments = this.mapService.lineSegmentsCm();
      const mapConfig = this.mapService.config();
      const robotConfig = this.vizService.robotConfig();
      const sensorConfig = this.vizService.sensorConfig();
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
        wallSegments,
        lineSegments,
        sensorConfig.lineSensors.length,
        mapConfig,
        robotConfig
      );
    });
  }

  private scheduleStepGeneration(
    wps: Waypoint[],
    start: { x: number; y: number; theta: number },
    threshold: number,
    useAStar: boolean,
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
      waypoints: wps.map(wp => ({ x: wp.x, y: wp.y })),
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
      rotationCenterForwardCm: this.vizService.robotConfig().rotationCenterForwardCm,
      rotationCenterStrafeCm: this.vizService.robotConfig().rotationCenterStrafeCm,
      maxLineupDistanceCm: Math.max(this.mapService.config().widthCm, this.mapService.config().heightCm),
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

  /** Computed: trajectory poses from the generated steps (with wall physics) */
  readonly computedTrajectory = computed<Pose2D[]>(() => {
    const steps = this.generatedSteps();
    const start = this._startPose();
    if (steps.length === 0) return [];
    const lineupContext = this.buildLineupContext();

    // First, compute the raw trajectory from commands
    const rawPoses: Pose2D[] = [];
    let currentPose: Pose2D = { x: start.x, y: start.y, theta: start.theta };
    rawPoses.push({ ...currentPose });

    for (const step of steps) {
      const fn = step.function_name;
      const arg = (step.arguments[0]?.value as number) ?? 0;

      if (fn === 'drive_until_black' || fn === 'drive_until_white') {
        if (lineupContext) {
          const target = fn === 'drive_until_black' ? 'black' : 'white';
          const drivePoses = simulateDriveUntilColor(currentPose, lineupContext, target);
          if (drivePoses.length) {
            rawPoses.push(...drivePoses);
            currentPose = drivePoses[drivePoses.length - 1];
          }
        }
        continue;
      }

      if (fn === 'forward_lineup_on_black') {
        if (lineupContext) {
          const lineupPoses = simulateForwardLineupOnBlack(currentPose, lineupContext);
          if (lineupPoses.length) {
            rawPoses.push(...lineupPoses);
            currentPose = lineupPoses[lineupPoses.length - 1];
          }
        }
        continue;
      }

      if (fn === 'forward_lineup_on_white') {
        if (lineupContext) {
          const lineupPoses = simulateForwardLineupOnWhite(currentPose, lineupContext);
          if (lineupPoses.length) {
            rawPoses.push(...lineupPoses);
            currentPose = lineupPoses[lineupPoses.length - 1];
          }
        }
        continue;
      }

      if (fn === 'backward_lineup_on_black') {
        if (lineupContext) {
          const lineupPoses = simulateBackwardLineupOnBlack(currentPose, lineupContext);
          if (lineupPoses.length) {
            rawPoses.push(...lineupPoses);
            currentPose = lineupPoses[lineupPoses.length - 1];
          }
        }
        continue;
      }

      if (fn === 'backward_lineup_on_white') {
        if (lineupContext) {
          const lineupPoses = simulateBackwardLineupOnWhite(currentPose, lineupContext);
          if (lineupPoses.length) {
            rawPoses.push(...lineupPoses);
            currentPose = lineupPoses[lineupPoses.length - 1];
          }
        }
        continue;
      }

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
        continue;
      }

      // For turns and other commands, just compute the final pose
      currentPose = simulateCommand(currentPose, step);
      rawPoses.push({ ...currentPose });
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
