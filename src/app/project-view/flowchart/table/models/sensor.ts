/**
 * Type of sensor-based step.
 */
export enum SensorStepType {
  LineUp = 'LineUp',
  FollowLine = 'FollowLine',
}

/**
 * Direction of robot movement during sensor maneuver.
 */
export enum MoveDirection {
  Forward = 'Forward',
  Backward = 'Backward',
}

/**
 * Color transition that triggers the sensor condition.
 */
export enum ColorTransition {
  /** Stop when sensor sees black (coming from white) */
  WhiteToBlack = 'WhiteToBlack',
  /** Stop when sensor sees white (coming from black) */
  BlackToWhite = 'BlackToWhite',
}

/**
 * Base interface for sensor-based steps.
 */
export interface SensorStep {
  type: SensorStepType;
}

/**
 * LineUp: Drive until both sensors detect the target color.
 */
export interface LineUpStep extends SensorStep {
  type: SensorStepType.LineUp;
  direction: MoveDirection;
  transition: ColorTransition;
  leftSensorIndex: number;
  rightSensorIndex: number;
}

/**
 * FollowLine: Keep line between two sensors.
 */
export interface FollowLineStep extends SensorStep {
  type: SensorStepType.FollowLine;
  leftSensorIndex: number;
  rightSensorIndex: number;
  direction: MoveDirection;
  maxDistanceCm?: number;
  stopOnIntersection: boolean;
}

export function createLineUpStep(
  direction: MoveDirection,
  transition: ColorTransition,
  leftSensorIndex: number,
  rightSensorIndex: number
): LineUpStep {
  return {
    type: SensorStepType.LineUp,
    direction,
    transition,
    leftSensorIndex,
    rightSensorIndex,
  };
}

export function createFollowLineStep(
  leftSensorIndex: number,
  rightSensorIndex: number,
  direction: MoveDirection = MoveDirection.Forward,
  maxDistanceCm?: number,
  stopOnIntersection = true
): FollowLineStep {
  return {
    type: SensorStepType.FollowLine,
    leftSensorIndex,
    rightSensorIndex,
    direction,
    maxDistanceCm,
    stopOnIntersection,
  };
}

/**
 * Defines a single line sensor position relative to robot's geometric center.
 */
export interface LineSensor {
  index: number;
  /** Forward offset from geometric center in cm (positive = front) */
  forwardCm: number;
  /** Strafe offset from geometric center in cm (positive = left) */
  strafeCm: number;
}

/**
 * Configuration for all line sensors on the robot.
 */
export interface SensorConfig {
  lineSensors: LineSensor[];
}

export function createSensorConfig(): SensorConfig {
  return { lineSensors: [] };
}

export function getSensor(config: SensorConfig, index: number): LineSensor | undefined {
  return config.lineSensors.find(s => s.index === index);
}

export function setSensor(
  config: SensorConfig,
  index: number,
  forwardCm: number,
  strafeCm: number
): void {
  config.lineSensors = config.lineSensors.filter(s => s.index !== index);
  config.lineSensors.push({ index, forwardCm, strafeCm });
}

export function clearSensors(config: SensorConfig): void {
  config.lineSensors = [];
}
