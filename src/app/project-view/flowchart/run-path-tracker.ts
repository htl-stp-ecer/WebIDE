import { signal } from '@angular/core';

export class RunPathTracker {
  readonly completedNodeIds = signal<Set<string>>(new Set());
  readonly completedConnectionIds = signal<Set<string>>(new Set());

  private pathToNodeId: Map<string, string> = new Map();
  private pathToConnectionIds: Map<string, string[]> = new Map();
  private plannedByIndex = new Map<number, string>();
  private plannedByOrder = new Map<number, string>();

  updateLookups(nodeLookup: Map<string, string>, connectionLookup: Map<string, string[]>): void {
    this.pathToNodeId = nodeLookup;
    this.pathToConnectionIds = connectionLookup;
  }

  reset(): void {
    this.completedNodeIds.set(new Set());
    this.completedConnectionIds.set(new Set());
    this.plannedByIndex.clear();
    this.plannedByOrder.clear();
  }

  cachePlannedSteps(payload: unknown): void {
    this.plannedByIndex.clear();
    this.plannedByOrder.clear();

    const steps = (payload as any)?.steps;
    if (!Array.isArray(steps)) return;

    steps.forEach((step: any, idx: number) => {
      const pathKey = this.normalizePathKey(step?.path);
      if (!pathKey) return;

      const timelineIdx = Number(step?.index);
      if (Number.isInteger(timelineIdx)) {
        this.plannedByIndex.set(timelineIdx, pathKey);
      }

      this.plannedByOrder.set(idx + 1, pathKey);
    });
  }

  handleStepEvent(event: any): void {
    this.recordCompletedPathKey(this.resolvePathKey(event));
  }

  isNodeCompleted(nodeId: string): boolean {
    return this.completedNodeIds().has(nodeId);
  }

  isConnectionCompleted(connectionId: string): boolean {
    return this.completedConnectionIds().has(connectionId);
  }

  private resolvePathKey(event: any): string | undefined {
    const direct = this.normalizePathKey(event?.path);
    if (direct) return direct;

    const timelineIdx = Number(event?.timeline_index);
    if (Number.isInteger(timelineIdx)) {
      const viaTimeline = this.plannedByIndex.get(timelineIdx);
      if (viaTimeline) return viaTimeline;
    }

    const sequentialIdx = Number(event?.index);
    if (Number.isInteger(sequentialIdx)) {
      return this.plannedByIndex.get(sequentialIdx) ?? this.plannedByOrder.get(sequentialIdx);
    }

    return undefined;
  }

  private normalizePathKey(raw: unknown): string | undefined {
    if (!Array.isArray(raw)) return undefined;

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

  private recordCompletedPathKey(pathKey?: string | null): void {
    if (!pathKey) return;

    const nodeId = this.pathToNodeId.get(pathKey);
    if (nodeId) {
      this.completedNodeIds.update(prev => {
        if (prev.has(nodeId)) return prev;
        const next = new Set(prev);
        next.add(nodeId);
        return next;
      });
    }

    const connectionIds = this.pathToConnectionIds.get(pathKey);
    if (!connectionIds?.length) return;

    this.completedConnectionIds.update(prev => {
      let needsCopy = false;
      for (const id of connectionIds) {
        if (!prev.has(id)) {
          needsCopy = true;
          break;
        }
      }
      if (!needsCopy) return prev;
      const next = new Set(prev);
      connectionIds.forEach(id => next.add(id));
      return next;
    });
  }
}
