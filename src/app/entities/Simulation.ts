export interface SimulationDelta {
  forward: number;
  strafe: number;
  angular: number;
}

export interface SimulationStepData {
  path: number[];
  function_name: string;
  step_type: string;
  label?: string;
  average_duration_ms: number;
  duration_stddev_ms: number;
  delta: SimulationDelta;
  children?: SimulationStepData[] | null;
}

export interface MissionSimulationData {
  name: string;
  is_setup: boolean;
  is_shutdown: boolean;
  order: number;
  steps: SimulationStepData[];
  total_duration_ms: number;
  total_delta: SimulationDelta;
}

export interface ProjectSimulationData {
  missions: MissionSimulationData[];
}
