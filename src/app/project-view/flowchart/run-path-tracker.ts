import { signal } from '@angular/core';

/**
 * Sentinel for step events that don't carry a ``mission_name`` (fast-sim,
 * legacy single-mission runs). Keeps the per-mission bookkeeping consistent
 * without needing an extra ``Set`` for "no mission".
 */
const ANONYMOUS_MISSION = '__anonymous__';

export class RunPathTracker {
  readonly completedNodeIds = signal<Set<string>>(new Set());
  readonly completedConnectionIds = signal<Set<string>>(new Set());

  private pathToNodeId: Map<string, string> = new Map();
  private pathToConnectionIds: Map<string, string[]> = new Map();
  private plannedByIndex = new Map<number, string>();
  private plannedByOrder = new Map<number, string>();
  /**
   * Name of the mission whose flowchart the user is currently viewing.
   * Null means no mission filter is applied (highlights everything that
   * matches by path).
   */
  private currentMissionName: string | null = null;

  /**
   * Persistent record of every step path that has fired during the current
   * run, grouped by emitting mission. Survives mission-view switches so the
   * user can flip between missions and still see what was already executed
   * in each one.
   */
  private completedPathsByMission = new Map<string, Set<string>>();

  updateLookups(nodeLookup: Map<string, string>, connectionLookup: Map<string, string[]>): void {
    this.pathToNodeId = nodeLookup;
    this.pathToConnectionIds = connectionLookup;
    // Lookups belong to the now-visible mission's flowchart — rebuild the
    // node/connection sets from the persistent per-mission record.
    this.rebuildVisibleHighlights();
  }

  setCurrentMissionName(name: string | null): void {
    if (this.currentMissionName === name) return;
    this.currentMissionName = name;
    this.rebuildVisibleHighlights();
  }

  /** Discard everything — used at the start of a new run. */
  reset(): void {
    this.completedNodeIds.set(new Set());
    this.completedConnectionIds.set(new Set());
    this.plannedByIndex.clear();
    this.plannedByOrder.clear();
    this.completedPathsByMission.clear();
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
    const pathKey = this.resolvePathKey(event);
    if (!pathKey) return;

    const evtMission = typeof event?.mission_name === 'string'
      ? event.mission_name as string
      : ANONYMOUS_MISSION;
    this.recordPathForMission(evtMission, pathKey);

    // Only paint the visible flowchart when the event belongs to the
    // currently viewed mission (or has no mission name at all).
    if (
      this.currentMissionName == null
      || evtMission === ANONYMOUS_MISSION
      || evtMission === this.currentMissionName
    ) {
      this.paintPathKey(pathKey);
    }
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

  private recordPathForMission(missionName: string, pathKey: string): void {
    let bucket = this.completedPathsByMission.get(missionName);
    if (!bucket) {
      bucket = new Set();
      this.completedPathsByMission.set(missionName, bucket);
    }
    bucket.add(pathKey);
  }

  /**
   * Recompute ``completedNodeIds`` / ``completedConnectionIds`` from the
   * persistent per-mission record using the current ``pathToNodeId`` map.
   * Called when the visible mission changes so highlights restore instead
   * of being thrown away.
   */
  private rebuildVisibleHighlights(): void {
    const nextNodes = new Set<string>();
    const nextConns = new Set<string>();

    const buckets: Iterable<Set<string>> = (() => {
      if (this.currentMissionName == null) {
        return this.completedPathsByMission.values();
      }
      const own = this.completedPathsByMission.get(this.currentMissionName);
      const anon = this.completedPathsByMission.get(ANONYMOUS_MISSION);
      const list: Set<string>[] = [];
      if (own) list.push(own);
      if (anon) list.push(anon);
      return list;
    })();

    for (const bucket of buckets) {
      for (const pathKey of bucket) {
        const nodeId = this.pathToNodeId.get(pathKey);
        if (nodeId) nextNodes.add(nodeId);
        const connIds = this.pathToConnectionIds.get(pathKey);
        if (connIds) connIds.forEach(id => nextConns.add(id));
      }
    }

    this.completedNodeIds.set(nextNodes);
    this.completedConnectionIds.set(nextConns);
  }

  private paintPathKey(pathKey: string): void {
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
