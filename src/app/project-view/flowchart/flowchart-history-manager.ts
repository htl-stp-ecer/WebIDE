import { WritableSignal } from '@angular/core';
import { Mission } from '../../entities/Mission';
import { MissionStateService } from '../../services/mission-sate-service';
import { Connection, FlowNode } from './models';
import {FlowHistory, FlowSnapshot} from '../../entities/flow-history';

interface FlowchartHistoryContext {
  missionState: MissionStateService;
  history: FlowHistory;
  missionNodes: WritableSignal<FlowNode[]>;
  missionConnections: WritableSignal<Connection[]>;
  adHocNodes: WritableSignal<FlowNode[]>;
  adHocConnections: WritableSignal<Connection[]>;
  nodes: WritableSignal<FlowNode[]>;
  connections: WritableSignal<Connection[]>;
  recomputeMergedView(): void;
  markNeedsAdjust(): void;
  markViewportResetPending(): void;
}

export class FlowchartHistoryManager {
  private readonly adHocPerMission = new Map<string, { nodes: FlowNode[]; connections: Connection[] }>();
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
          nodes: this.cloneNodes(this.ctx.adHocNodes()),
          connections: this.cloneConnections(this.ctx.adHocConnections()),
        });
      }

      const saved = newKey ? this.adHocPerMission.get(newKey) : null;

      this.ctx.missionNodes.set([]);
      this.ctx.missionConnections.set([]);
      this.ctx.nodes.set([]);
      this.ctx.connections.set([]);
      this.ctx.adHocNodes.set(this.cloneNodes(saved?.nodes ?? []));
      this.ctx.adHocConnections.set(this.cloneConnections(saved?.connections ?? []));
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
      const missionClone = this.cloneMission(snapshot.mission);
      this.ignoreMissionEffect = true;
      this.ctx.missionState.currentMission.set(missionClone);
      this.ignoreMissionEffect = false;

      const missionNodes = this.cloneNodes(snapshot.missionNodes);
      const missionConnections = this.cloneConnections(snapshot.missionConnections);
      const adHocNodes = this.cloneNodes(snapshot.adHocNodes);
      const adHocConnections = this.cloneConnections(snapshot.adHocConnections);

      this.ctx.missionNodes.set(missionNodes);
      this.ctx.missionConnections.set(missionConnections);
      this.ctx.adHocNodes.set(adHocNodes);
      this.ctx.adHocConnections.set(adHocConnections);

      if (this.currentMissionKey) {
        this.adHocPerMission.set(this.currentMissionKey, {
          nodes: this.cloneNodes(adHocNodes),
          connections: this.cloneConnections(adHocConnections),
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
      mission: this.cloneMission(this.ctx.missionState.currentMission()),
      missionNodes: this.cloneNodes(this.ctx.missionNodes()),
      missionConnections: this.cloneConnections(this.ctx.missionConnections()),
      adHocNodes: this.cloneNodes(this.ctx.adHocNodes()),
      adHocConnections: this.cloneConnections(this.ctx.adHocConnections()),
    };
  }

  private cloneNodes(nodes: FlowNode[] | undefined): FlowNode[] {
    return this.clonePlain(nodes ?? []);
  }

  private cloneConnections(connections: Connection[] | undefined): Connection[] {
    return this.clonePlain(connections ?? []);
  }

  private cloneMission(mission: Mission | null): Mission | null {
    return mission ? this.clonePlain(mission) : null;
  }

  private clonePlain<T>(value: T): T {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private buildMissionKey(mission: Mission | null): string | null {
    if (!mission) {
      return null;
    }
    return ((mission as any).uuid ?? mission.name) ?? null;
  }
}
