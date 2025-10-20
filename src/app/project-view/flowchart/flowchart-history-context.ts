import { WritableSignal } from '@angular/core';
import { FlowHistory } from '../../entities/flow-history';
import { MissionStateService } from '../../services/mission-sate-service';
import { Connection, FlowComment, FlowNode } from './models';

export interface FlowchartHistoryContext {
  missionState: MissionStateService;
  history: FlowHistory;
  missionNodes: WritableSignal<FlowNode[]>;
  missionConnections: WritableSignal<Connection[]>;
  adHocNodes: WritableSignal<FlowNode[]>;
  adHocConnections: WritableSignal<Connection[]>;
  comments: WritableSignal<FlowComment[]>;
  nodes: WritableSignal<FlowNode[]>;
  connections: WritableSignal<Connection[]>;
  recomputeMergedView(): void;
  markNeedsAdjust(): void;
  markViewportResetPending(): void;
}
