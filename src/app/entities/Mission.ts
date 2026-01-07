import { MissionStep } from './MissionStep';
import { MissionComment } from './MissionComment';
import { MissionGroup } from './MissionGroup';

export interface Mission {
  "name": string,
  "is_setup": boolean,
  "is_shutdown": boolean,
  "order": number,
  "steps": MissionStep[],
  "comments"?: MissionComment[],
  "groups"?: MissionGroup[],
}
