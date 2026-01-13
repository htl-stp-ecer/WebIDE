import { Injectable, signal, computed } from '@angular/core';
import { Pose2D, createPose } from '../models';
import { SensorConfig, createSensorConfig, setSensor, SensorStepType } from '../models';

export interface RobotConfig {
  widthCm: number;
  lengthCm: number;
  rotationCenterForwardCm: number;
  rotationCenterStrafeCm: number;
}

export interface ExpandedStep {
  isMicroStep?: boolean;
  parentStepId?: string;
  parentSensorType?: SensorStepType;
}

export interface ComputedPath {
  poses: Pose2D[];
  expandedSteps: ExpandedStep[];
}

/**
 * Service for managing table visualization state.
 * Holds robot configuration, start pose, current pose, and computed path.
 */
@Injectable({ providedIn: 'root' })
export class TableVisualizationService {
  private readonly _robotConfig = signal<RobotConfig>({
    widthCm: 15,
    lengthCm: 22,
    rotationCenterForwardCm: 0,
    rotationCenterStrafeCm: 0,
  });

  private readonly _sensorConfig = signal<SensorConfig>(createSensorConfig());
  private readonly _startPose = signal<Pose2D>(createPose(20, 50, 0));
  private readonly _currentPose = signal<Pose2D | null>(null);
  private readonly _computedPath = signal<ComputedPath | null>(null);
  private readonly _plannedPath = signal<Pose2D[] | null>(null);
  private readonly _plannedMissionEndIndices = signal<number[] | null>(null);
  private readonly _plannedHighlightRange = signal<{ startIndex: number; endIndex: number } | null>(null);
  private readonly _plannedPathLoading = signal<boolean>(false);

  readonly robotConfig = this._robotConfig.asReadonly();
  readonly sensorConfig = this._sensorConfig.asReadonly();
  readonly startPose = this._startPose.asReadonly();
  readonly currentPose = computed(() => this._currentPose() ?? this._startPose());
  readonly computedPath = this._computedPath.asReadonly();
  readonly plannedPath = this._plannedPath.asReadonly();
  readonly plannedMissionEndIndices = this._plannedMissionEndIndices.asReadonly();
  readonly plannedHighlightRange = this._plannedHighlightRange.asReadonly();
  readonly plannedPathLoading = this._plannedPathLoading.asReadonly();

  /** End pose after all planned steps (or start pose if no path) */
  readonly plannedEndPose = computed<Pose2D>(() => {
    const path = this._plannedPath();
    if (path && path.length > 0) {
      return path[path.length - 1];
    }
    return this._startPose();
  });

  /** Set the start pose */
  setStartPose(x: number, y: number, thetaDeg: number): void {
    this._startPose.set(createPose(x, y, thetaDeg));
    // Reset current pose to start pose
    this._currentPose.set(null);
  }

  /** Set current pose (e.g., during animation) */
  setCurrentPose(pose: Pose2D | null): void {
    this._currentPose.set(pose);
  }

  /** Set robot dimensions */
  setRobotDimensions(widthCm: number, lengthCm: number): void {
    this._robotConfig.update(c => ({ ...c, widthCm, lengthCm }));
  }

  /** Set rotation center offset */
  setRotationCenter(forwardCm: number, strafeCm: number): void {
    this._robotConfig.update(c => ({
      ...c,
      rotationCenterForwardCm: forwardCm,
      rotationCenterStrafeCm: strafeCm,
    }));
  }

  /** Configure a line sensor */
  configureLineSensor(index: number, forwardCm: number, strafeCm: number): void {
    this._sensorConfig.update(c => {
      const newConfig = { lineSensors: [...c.lineSensors] };
      setSensor(newConfig, index, forwardCm, strafeCm);
      return newConfig;
    });
  }

  /** Clear all sensors */
  clearSensors(): void {
    this._sensorConfig.set(createSensorConfig());
  }

  /** Set the computed path (array of poses and expanded steps) */
  setComputedPath(path: ComputedPath | null): void {
    this._computedPath.set(path);
  }

  /** Set the planned path (array of poses) */
  setPlannedPath(path: Pose2D[] | null): void {
    this._plannedPath.set(path);
    if (!path) {
      this._plannedMissionEndIndices.set(null);
      this._plannedHighlightRange.set(null);
    }
  }

  /** Toggle loading state for planned path updates */
  setPlannedPathLoading(loading: boolean): void {
    this._plannedPathLoading.set(loading);
  }

  /** Set indices for planned mission end poses */
  setPlannedMissionEndIndices(indices: number[] | null): void {
    this._plannedMissionEndIndices.set(indices?.length ? [...indices] : null);
  }

  /** Set planned path highlight range */
  setPlannedHighlightRange(range: { startIndex: number; endIndex: number } | null): void {
    this._plannedHighlightRange.set(range ? { ...range } : null);
  }

  /** Add a single pose to the path (for building incrementally) */
  addPoseToPath(pose: Pose2D, step?: ExpandedStep): void {
    const currentPath = this._computedPath();
    if (currentPath) {
      this._computedPath.set({
        poses: [...currentPath.poses, pose],
        expandedSteps: step ? [...currentPath.expandedSteps, step] : currentPath.expandedSteps,
      });
    } else {
      this._computedPath.set({
        poses: [this._startPose(), pose],
        expandedSteps: step ? [step] : [],
      });
    }
  }

  /** Clear the path */
  clearPath(): void {
    this._computedPath.set(null);
  }

  /** Reset all state to defaults */
  reset(): void {
    this._robotConfig.set({
      widthCm: 15,
      lengthCm: 22,
      rotationCenterForwardCm: 0,
      rotationCenterStrafeCm: 0,
    });
    this._sensorConfig.set(createSensorConfig());
    this._startPose.set(createPose(20, 50, 0));
    this._currentPose.set(null);
    this._computedPath.set(null);
    this._plannedPath.set(null);
    this._plannedMissionEndIndices.set(null);
    this._plannedHighlightRange.set(null);
    this._plannedPathLoading.set(false);
  }

  /** Configure default sensors (typical 2-sensor setup for line following) */
  configureDefaultSensors(): void {
    // Default left sensor: 8cm forward, 3cm left of center
    this.configureLineSensor(0, 8, 3);
    // Default right sensor: 8cm forward, 3cm right of center
    this.configureLineSensor(1, 8, -3);
  }
}
