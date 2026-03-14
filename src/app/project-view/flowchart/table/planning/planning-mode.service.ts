import { Injectable, inject, signal, computed } from '@angular/core';
import { Waypoint, createWaypoint } from './models';
import { MissionStep } from '../../../../entities/MissionStep';
import { optimizeWaypointsToSteps, OptimizationContext } from './path-optimizer';
import { TableMapService } from '../services';
import { TableVisualizationService } from '../services';

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

  readonly isActive = this._isActive.asReadonly();
  readonly waypoints = this._waypoints.asReadonly();
  readonly selectedIndex = this._selectedIndex.asReadonly();
  readonly draggingIndex = this._draggingIndex.asReadonly();
  readonly startPose = this._startPose.asReadonly();
  readonly lineupThreshold = this._lineupThreshold.asReadonly();

  /** Computed: generated mission steps from current waypoints (with lineup optimization) */
  readonly generatedSteps = computed<MissionStep[]>(() => {
    const wps = this._waypoints();
    const start = this._startPose();
    const threshold = this._lineupThreshold();
    if (wps.length < 1) return [];

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

  /** Add a waypoint at the given position */
  addWaypoint(
    x: number,
    y: number,
    lineup = false,
    lineupLineIndex?: number,
    lineSnapAction?: 'lineup' | 'follow' | 'drive'
  ): void {
    const wp = createWaypoint(x, y, lineup, lineupLineIndex, lineSnapAction);
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
  moveWaypoint(
    index: number,
    x: number,
    y: number,
    lineup?: boolean,
    lineupLineIndex?: number,
    lineSnapAction?: 'lineup' | 'follow' | 'drive'
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

  /** Clear lineup flags from all waypoints */
  clearWaypointLineups(): void {
    this._waypoints.update(wps =>
      wps.map(wp => (wp.lineup ? { ...wp, lineup: false, lineupLineIndex: undefined, lineSnapAction: undefined } : wp))
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
