export interface MissionStep {
  step_type: string,
  function_name: string,
  arguments: {
    name: string,
    value: string,
    type: string,
  }[],
  position?: {
    x: number,
    y: number,
  },
  children: MissionStep[],
}
