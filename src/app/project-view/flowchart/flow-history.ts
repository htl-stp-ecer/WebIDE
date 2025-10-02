import { Injectable } from '@angular/core';
import { Mutator } from '@foblex/mutator';

import { Mission } from '../../entities/Mission';
import { Connection, FlowNode } from './models';

export interface FlowSnapshot {
  mission: Mission | null;
  missionNodes: FlowNode[];
  missionConnections: Connection[];
  adHocNodes: FlowNode[];
  adHocConnections: Connection[];
}

@Injectable()
export class FlowHistory extends Mutator<FlowSnapshot> {}
