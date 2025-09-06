import {MissionStep} from './MissionStep';

export interface Mission {
  "name": string,
  "is_setup": boolean,
  "is_shutdown": boolean,
  "order": number,
  "steps": MissionStep[],
}
