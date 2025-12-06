import { WritableSignal, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { HttpService } from '../../services/http-service';
import { RunPathTracker } from './run-path-tracker';

type DebugState = 'idle' | 'running' | 'paused';

interface BreakpointEventPayload {
  index?: number;
  timeline_index?: number;
  path?: number[];
  name?: string;
  step_type?: string;
  display_label?: string;
  [key: string]: unknown;
}

interface FlowchartRunContext {
  http: HttpService;
  isRunActive: WritableSignal<boolean>;
  debugState: WritableSignal<DebugState>;
  breakpointInfo: WritableSignal<BreakpointEventPayload | null>;
  getProjectUUID(): string | null;
  getMissionKey(): string | null;
}

export interface StepTiming {
  id: string;
  index: number;
  label?: string;
  path?: string;
  durationMs: number;
  timestampMs: number;
  elapsedMs: number;
}

export class FlowchartRunManager {
  private readonly tracker = new RunPathTracker();
  private runSubscription: Subscription | null = null;
  private currentSocket: WebSocket | null = null;
  private currentMode: 'normal' | 'debug' | null = null;
  private paused = false;
  private bufferedEvents: unknown[] = [];
  private runStartMs: number | null = null;
  private lastStepTimestampMs: number | null = null;
  private pathToNodeId: Map<string, string> = new Map();
  private accumulatedMs = 0;

  readonly stepTimings = signal<StepTiming[]>([]);
  readonly maxStepDurationMs = signal(0);
  readonly nodeTimings = signal<Map<string, StepTiming>>(new Map());

  constructor(private readonly ctx: FlowchartRunContext) {}

  private updateSocket(socket: WebSocket | null): void {
    if (!socket) {
      this.currentSocket = null;
      return;
    }
    if (this.currentSocket && this.currentSocket !== socket && this.currentSocket.readyState === WebSocket.OPEN) {
      try {
        this.currentSocket.close(1000, 'Replaced');
      } catch {
        // Best-effort cleanup; ignore
      }
    }
    this.currentSocket = socket;
    socket.addEventListener('close', () => {
      if (this.currentSocket === socket) {
        this.currentSocket = null;
      }
    });
  }

  private resetDebugState(): void {
    this.ctx.debugState.set('idle');
    this.ctx.breakpointInfo.set(null);
    this.currentMode = null;
    this.paused = false;
    this.bufferedEvents = [];
  }

  private handleBreakpointEvent(event: BreakpointEventPayload & { state?: string } & Record<string, unknown>): void {
    if (this.currentMode !== 'debug') {
      return;
    }
    const state = typeof event.state === 'string' ? event.state.toLowerCase() : '';
    if (state === 'waiting') {
      if (!this.paused) {
        this.paused = true;
        this.ctx.debugState.set('paused');
      }
      this.ctx.breakpointInfo.set(event);
      return;
    }
    if (state === 'resumed') {
      this.paused = false;
      this.ctx.debugState.set('running');
      this.ctx.breakpointInfo.set(null);
      return;
    }
    if (state === 'cancelled') {
      this.paused = false;
      this.ctx.debugState.set('idle');
      this.ctx.breakpointInfo.set(null);
      this.bufferedEvents = [];
    }
  }

  updatePathLookups(pathToNodeId: Map<string, string>, pathToConnectionIds: Map<string, string[]>): void {
    this.tracker.updateLookups(pathToNodeId, pathToConnectionIds);
    this.pathToNodeId = new Map(pathToNodeId);
    this.nodeTimings.set(new Map());
  }

  clearRunVisuals(): void {
    this.tracker.reset();
  }

  isNodeCompleted(nodeId: string): boolean {
    return this.tracker.isNodeCompleted(nodeId);
  }

  isConnectionCompleted(connectionId: string): boolean {
    return this.tracker.isConnectionCompleted(connectionId);
  }

  getNodeTiming(nodeId: string): StepTiming | undefined {
    return this.nodeTimings().get(nodeId);
  }

  handleRunEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    if (this.paused) {
      this.bufferedEvents.push(event);
      return;
    }
    this.processEvent(event as Record<string, unknown>);
  }

  private processEvent(payload: Record<string, unknown>): void {
    this.logEventTimestamp(payload);
    const type = String((payload as { type?: unknown }).type ?? '');
    switch (type) {
      case 'started':
        this.markRunStart(payload);
        break;
      case 'open':
        this.ctx.isRunActive.set(true);
        if (this.currentMode === 'debug') {
          this.ctx.debugState.set('running');
          this.ctx.breakpointInfo.set(null);
        }
        break;
      case 'planned_steps':
        this.tracker.cachePlannedSteps(payload);
        break;
      case 'step':
        this.tracker.handleStepEvent(payload);
        this.recordStepTiming(payload);
        if (
          this.currentMode === 'debug' &&
          !this.paused &&
          typeof payload['step_type'] === 'string' &&
          (payload['step_type'] as string).toLowerCase() === 'breakpoint'
        ) {
          this.pauseAtBreakpoint(payload as BreakpointEventPayload);
        }
        break;
      case 'breakpoint':
        this.handleBreakpointEvent(payload as BreakpointEventPayload & { state?: string });
        break;
      case 'exit':
      case 'error':
        this.ctx.isRunActive.set(false);
        this.resetDebugState();
        break;
      default:
        break;
    }
  }

  private logEventTimestamp(payload: Record<string, unknown>): void {
    const type = String((payload as { type?: unknown }).type ?? '');
    if (type !== 'step') return;

    const parsedMs = this.extractTimestampMs(payload) ?? Date.now();
    const ts = new Date(parsedMs);

    const label = (payload['display_label'] as string) || (payload['name'] as string);
    const path = Array.isArray(payload['path']) ? (payload['path'] as unknown[]).join('.') : undefined;
    const summary = label || path ? { label: label || path } : undefined;

    if (summary) {
      console.log(`[Flowchart] Step event at ${ts.toISOString()}`, summary, payload);
    } else {
      console.log(`[Flowchart] Step event at ${ts.toISOString()}`, payload);
    }
  }

  stopRun(): void {
    const hadSubscription = !!this.runSubscription;
    const wasActive = this.ctx.isRunActive();
    if (!hadSubscription && !wasActive) return;

    this.runSubscription?.unsubscribe();
    this.runSubscription = null;
    this.ctx.isRunActive.set(false);
    this.resetDebugState();

    const projectUUID = this.ctx.getProjectUUID();
    if (projectUUID) {
      this.ctx.http.stopMission(projectUUID).subscribe({
        error: err => console.error('Failed to stop mission', err),
      });
    }
    this.bufferedEvents = [];
    this.paused = false;
  }

  onRun(mode: 'normal' | 'debug'): void {
    const projectId = this.ctx.getProjectUUID();
    const missionKey = this.ctx.getMissionKey();
    if (!projectId || !missionKey) {
      console.warn('Run aborted: missing project or mission identifier.');
      return;
    }

    this.runSubscription?.unsubscribe();
    this.runSubscription = null;

    this.clearRunVisuals();
    this.resetTimingData();
    this.ctx.isRunActive.set(true);
    this.ctx.debugState.set('idle');
    this.ctx.breakpointInfo.set(null);
    this.currentMode = mode;
    this.updateSocket(null);
    this.paused = false;
    this.bufferedEvents = [];

    const runOptions = mode === 'debug'
      ? { simulate: true, debug: true, onSocket: (socket: WebSocket | null) => this.updateSocket(socket) }
      : { simulate: true, onSocket: (socket: WebSocket | null) => this.updateSocket(socket) };

    this.runSubscription = this.ctx.http.runMission(projectId, missionKey, runOptions).subscribe({
      next: event => this.handleRunEvent(event),
      error: err => {
        console.error('Mission run failed', err);
        this.ctx.isRunActive.set(false);
        this.resetDebugState();
        this.runSubscription = null;
      },
      complete: () => {
        this.ctx.isRunActive.set(false);
        this.resetDebugState();
        this.runSubscription = null;
      },
    });
  }

  onDebugContinue(): void {
    if (this.currentMode !== 'debug') {
      return;
    }
    if (this.ctx.debugState() !== 'paused') {
      return;
    }
    const socket = this.currentSocket;
    this.paused = false;
    this.ctx.debugState.set('running');
    this.ctx.breakpointInfo.set(null);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn('Debug continue requested but socket is unavailable.');
    } else {
      try {
        socket.send(JSON.stringify({ type: 'debug', action: 'resume' }));
      } catch (err) {
        console.error('Failed to send debug resume command', err);
      }
    }
    this.flushBufferedEvents();
  }

  private pauseAtBreakpoint(info: BreakpointEventPayload): void {
    if (this.paused || this.currentMode !== 'debug') {
      return;
    }
    this.paused = true;
    this.ctx.debugState.set('paused');
    this.ctx.breakpointInfo.set(info);
  }

  private flushBufferedEvents(): void {
    if (!this.bufferedEvents.length) return;
    const queue = this.bufferedEvents.splice(0);
    for (const event of queue) {
      this.handleRunEvent(event);
    }
  }

  private markRunStart(payload: Record<string, unknown>): void {
    const ts = this.extractTimestampMs(payload) ?? Date.now();
    this.runStartMs = ts;
    this.lastStepTimestampMs = null;
    this.accumulatedMs = 0;
  }

  private recordStepTiming(payload: Record<string, unknown>): void {
    const tsMs = this.extractTimestampMs(payload) ?? Date.now();
    if (this.runStartMs === null) {
      this.runStartMs = tsMs;
    }

    const prevTs = this.lastStepTimestampMs ?? this.runStartMs;
    const durationMs = prevTs !== null ? Math.max(0, tsMs - prevTs) : 0;
    this.lastStepTimestampMs = tsMs;
    this.accumulatedMs += durationMs;
    const label = (payload['display_label'] as string) || (payload['name'] as string) || (payload['step_type'] as string);
    const pathArr = Array.isArray(payload['path']) ? payload['path'] as unknown[] : undefined;
    const path = pathArr ? pathArr.join('.') : undefined;
    const index = Number((payload as { index?: unknown }).index) || this.stepTimings().length + 1;

    const entry: StepTiming = {
      id: `${index}-${path || label || 'step'}`,
      index,
      label: label || undefined,
      path,
      durationMs,
      timestampMs: tsMs,
      elapsedMs: this.accumulatedMs,
    };

    this.stepTimings.update(prev => [...prev, entry]);
    this.maxStepDurationMs.update(prev => Math.max(prev, durationMs));

    if (path) {
      const nodeId = this.pathToNodeId.get(path);
      if (nodeId) {
        this.nodeTimings.update(prev => {
          const next = new Map(prev);
          next.set(nodeId, entry);
          return next;
        });
      }
    }
  }

  private extractTimestampMs(payload: Record<string, unknown>): number | null {
    const raw = (payload as { timestamp?: unknown }).timestamp;
    if (typeof raw === 'number') {
      return raw * 1000;
    }
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private resetTimingData(): void {
    this.runStartMs = null;
    this.lastStepTimestampMs = null;
    this.stepTimings.set([]);
    this.maxStepDurationMs.set(0);
    this.nodeTimings.set(new Map());
    this.accumulatedMs = 0;
  }
}
