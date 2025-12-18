import { Injectable } from '@angular/core';
import { Mutator } from '@foblex/mutator';

import {Mission} from './Mission';
import {Connection, FlowComment, FlowGroup, FlowNode} from '../project-view/flowchart/models';

export interface FlowSnapshot {
  mission: Mission | null;
  missionNodes: FlowNode[];
  missionConnections: Connection[];
  adHocNodes: FlowNode[];
  adHocConnections: Connection[];
  comments: FlowComment[];
  groups: FlowGroup[];
}

@Injectable()
export class FlowHistory extends Mutator<FlowSnapshot> {}
