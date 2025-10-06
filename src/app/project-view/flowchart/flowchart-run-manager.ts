import { WritableSignal, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { HttpService } from '../../services/http-service';

interface FlowchartRunContext {
  http: HttpService;
  isRunActive: WritableSignal<boolean>;
  getProjectUUID(): string | null;
  getMissionKey(): string | null;
}

export class FlowchartRunManager {
  private readonly completedNodeIds = signal<Set<string>>(new Set());
  private readonly completedConnectionIds = signal<Set<string>>(new Set());
  private readonly plannedStepsByIndex = new Map<number, string>();
  private readonly plannedStepsByOrder = new Map<number, string>();

  private pathToNodeId: Map<string, string> = new Map();
  private pathToConnectionIds: Map<string, string[]> = new Map();
  private runSubscription: Subscription | null = null;

  constructor(private readonly ctx: FlowchartRunContext) {}

  updatePathLookups(pathToNodeId: Map<string, string>, pathToConnectionIds: Map<string, string[]>): void {
    this.pathToNodeId = pathToNodeId;
    this.pathToConnectionIds = pathToConnectionIds;
  }

  clearRunVisuals(): void {
    this.completedNodeIds.set(new Set());
    this.completedConnectionIds.set(new Set());
    this.plannedStepsByIndex.clear();
    this.plannedStepsByOrder.clear();
  }

  isNodeCompleted(nodeId: string): boolean {
    return this.completedNodeIds().has(nodeId);
  }

  isConnectionCompleted(connectionId: string): boolean {
    return this.completedConnectionIds().has(connectionId);
  }

  handleRunEvent(event: any): void {
    if (!event || typeof event !== 'object') {
      return;
    }

    switch ((event as any).type) {
      case 'open':
        this.ctx.isRunActive.set(true);
        break;
      case 'planned_steps':
        this.cachePlannedSteps(event);
        break;
      case 'step':
        this.handleStepEvent(event);
        break;
      case 'exit':
      case 'error':
        this.ctx.isRunActive.set(false);
        break;
      default:
        break;
    }
  }

  stopRun(): void {
    const hadSubscription = !!this.runSubscription;
    const wasActive = this.ctx.isRunActive();

    if (!hadSubscription && !wasActive) {
      return;
    }

    this.runSubscription?.unsubscribe();
    this.runSubscription = null;
    this.ctx.isRunActive.set(false);

    const projectUUID = this.ctx.getProjectUUID();
    if (projectUUID) {
      this.ctx.http.stopMission(projectUUID).subscribe({
        error: err => console.error('Failed to stop mission', err),
      });
    }
  }

  onRun(mode: 'normal' | 'debug'): void {
    if (mode === 'normal') {
      const projectId = this.ctx.getProjectUUID();
      const missionKey = this.ctx.getMissionKey();

      if (!projectId || !missionKey) {
        console.warn('Run aborted: missing project or mission identifier.');
        return;
      }

      if (this.runSubscription) {
        this.runSubscription.unsubscribe();
        this.runSubscription = null;
      }

      this.clearRunVisuals();
      this.ctx.isRunActive.set(true);
      this.runSubscription = this.ctx.http.runMission(projectId, missionKey).subscribe({
        next: event => this.handleRunEvent(event),
        error: err => {
          console.error('Mission run failed', err);
          this.ctx.isRunActive.set(false);
          this.runSubscription = null;
        },
        complete: () => {
          this.ctx.isRunActive.set(false);
          this.runSubscription = null;
        },
      });
    } else {
      console.log('Debug!');
    }
  }

  private cachePlannedSteps(payload: unknown): void {
    this.plannedStepsByIndex.clear();
    this.plannedStepsByOrder.clear();

    const steps = (payload as any)?.steps;
    if (!Array.isArray(steps)) {
      return;
    }

    steps.forEach((step: any, idx: number) => {
      const pathKey = this.normalizePathKey(step?.path);
      if (!pathKey) {
        return;
      }

      const timelineIdx = Number(step?.index);
      if (Number.isInteger(timelineIdx)) {
        this.plannedStepsByIndex.set(timelineIdx, pathKey);
      }

      const sequentialIdx = idx + 1;
      this.plannedStepsByOrder.set(sequentialIdx, pathKey);
    });
  }

  private normalizePathKey(raw: unknown): string | undefined {
    if (!Array.isArray(raw)) {
      return undefined;
    }

    const parts: number[] = [];
    for (const part of raw) {
      const num = Number(part);
      if (!Number.isInteger(num) || num <= 0) {
        return undefined;
      }
      parts.push(num);
    }

    return parts.length ? parts.join('.') : undefined;
  }

  private resolvePathKeyFromEvent(event: any): string | undefined {
    const direct = this.normalizePathKey(event?.path);
    if (direct) {
      return direct;
    }

    const timelineIdx = Number(event?.timeline_index);
    if (Number.isInteger(timelineIdx)) {
      const viaTimeline = this.plannedStepsByIndex.get(timelineIdx);
      if (viaTimeline) {
        return viaTimeline;
      }
    }

    const seqIdx = Number(event?.index);
    if (Number.isInteger(seqIdx)) {
      return this.plannedStepsByIndex.get(seqIdx) ?? this.plannedStepsByOrder.get(seqIdx);
    }

    return undefined;
  }

  private handleStepEvent(event: any): void {
    const pathKey = this.resolvePathKeyFromEvent(event);
    this.recordCompletedPathKey(pathKey);
  }

  private recordCompletedPathKey(pathKey?: string | null): void {
    if (!pathKey) {
      return;
    }

    const nodeId = this.pathToNodeId.get(pathKey);
    if (!nodeId) {
      return;
    }

    this.completedNodeIds.update(prev => {
      if (prev.has(nodeId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });

    const connIds = this.pathToConnectionIds.get(pathKey) ?? [];
    if (!connIds.length) {
      return;
    }

    this.completedConnectionIds.update(prev => {
      let needsCopy = false;
      for (const id of connIds) {
        if (!prev.has(id)) {
          needsCopy = true;
          break;
        }
      }
      if (!needsCopy) {
        return prev;
      }
      const next = new Set(prev);
      connIds.forEach(id => next.add(id));
      return next;
    });
  }
}
