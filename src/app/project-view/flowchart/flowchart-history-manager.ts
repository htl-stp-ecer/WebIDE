import { Mission } from '../../entities/Mission';
import { Connection, FlowComment, FlowNode } from './models';
import { FlowSnapshot } from '../../entities/flow-history';
import { cloneConnections, cloneMission, cloneNodes, cloneComments } from './history-clone';
import type { FlowchartHistoryContext } from './flowchart-history-context';
export class FlowchartHistoryManager {
  private readonly adHocPerMission = new Map<string, { nodes: FlowNode[]; connections: Connection[]; comments: FlowComment[] }>();
  private currentMissionKey: string | null = null;
  private historyInitialized = false;
  private isRestoringHistory = false;
  private ignoreMissionEffect = false;
  private isHistoryTraversal = false;

  constructor(private readonly ctx: FlowchartHistoryContext) {}
  getMissionKey(): string | null {
    return this.currentMissionKey;
  }
  shouldProcessMissionEffect(): boolean {
    if (this.isRestoringHistory) {
      return false;
    }
    if (this.ignoreMissionEffect) {
      this.ignoreMissionEffect = false;
      return false;
    }
    return true;
  }
  prepareForMission(mission: Mission | null): boolean {
    const newKey = this.buildMissionKey(mission);
    const missionChanged = newKey !== this.currentMissionKey;

    if (missionChanged) {
      if (this.currentMissionKey) {
        this.adHocPerMission.set(this.currentMissionKey, {
          nodes: cloneNodes(this.ctx.adHocNodes()),
          connections: cloneConnections(this.ctx.adHocConnections()),
          comments: cloneComments(this.ctx.comments()),
        });
      }

      const saved = newKey ? this.adHocPerMission.get(newKey) : null;
      this.ctx.missionNodes.set([]);
      this.ctx.missionConnections.set([]);
      this.ctx.nodes.set([]);
      this.ctx.connections.set([]);
      this.ctx.adHocNodes.set(cloneNodes(saved?.nodes ?? []));
      this.ctx.adHocConnections.set(cloneConnections(saved?.connections ?? []));
      this.ctx.comments.set(cloneComments(saved?.comments ?? []));
      this.ctx.markViewportResetPending();
      this.currentMissionKey = newKey;
      this.historyInitialized = false;
    }

    return missionChanged;
  }
  clearFlowState(): void {
    this.ctx.missionNodes.set([]);
    this.ctx.missionConnections.set([]);
    this.ctx.nodes.set([]);
    this.ctx.connections.set([]);
    this.ctx.comments.set([]);
  }
  recordHistory(notifier: string): void {
    if (this.isRestoringHistory) {
      return;
    }

    const snapshot = this.buildSnapshot();
    if (!this.historyInitialized) {
      this.ctx.history.initialize(snapshot);
      this.historyInitialized = true;
      return;
    }

    this.ctx.history.update(snapshot, notifier);
  }
  resetHistoryWithCurrentState(): void {
    const snapshot = this.buildSnapshot();
    this.ctx.history.initialize(snapshot);
    this.historyInitialized = true;
  }
  beginHistoryTraversal(): void {
    this.isHistoryTraversal = true;
  }
  isTraversingHistory(): boolean {
    return this.isHistoryTraversal;
  }
  applySnapshotFromHistory(): void {
    const snapshot = this.ctx.history.getSnapshot();
    this.applyHistorySnapshot(snapshot);
    this.isHistoryTraversal = false;
  }
  private applyHistorySnapshot(snapshot: FlowSnapshot): void {
    this.isRestoringHistory = true;
    try {
      const missionClone = cloneMission(snapshot.mission);
      this.ignoreMissionEffect = true;
      this.ctx.missionState.currentMission.set(missionClone);
      this.ignoreMissionEffect = false;

      const missionNodes = cloneNodes(snapshot.missionNodes);
      const missionConnections = cloneConnections(snapshot.missionConnections);
      const adHocNodes = cloneNodes(snapshot.adHocNodes);
      const adHocConnections = cloneConnections(snapshot.adHocConnections);
      const comments = cloneComments(snapshot.comments);

      this.ctx.missionNodes.set(missionNodes);
      this.ctx.missionConnections.set(missionConnections);
      this.ctx.adHocNodes.set(adHocNodes);
      this.ctx.adHocConnections.set(adHocConnections);
      this.ctx.comments.set(comments);

      if (this.currentMissionKey) {
        this.adHocPerMission.set(this.currentMissionKey, {
          nodes: cloneNodes(adHocNodes),
          connections: cloneConnections(adHocConnections),
          comments: cloneComments(comments),
        });
      }

      this.ctx.recomputeMergedView();
      this.ctx.markNeedsAdjust();
      this.historyInitialized = true;
    } finally {
      this.isRestoringHistory = false;
    }
  }
  private buildSnapshot(): FlowSnapshot {
    return {
      mission: cloneMission(this.ctx.missionState.currentMission()),
      missionNodes: cloneNodes(this.ctx.missionNodes()),
      missionConnections: cloneConnections(this.ctx.missionConnections()),
      adHocNodes: cloneNodes(this.ctx.adHocNodes()),
      adHocConnections: cloneConnections(this.ctx.adHocConnections()),
      comments: cloneComments(this.ctx.comments()),
    };
  }
  private buildMissionKey(mission: Mission | null): string | null {
    if (!mission) {
      return null;
    }
    return ((mission as any).uuid ?? mission.name) ?? null;
  }
}
