import { WritableSignal } from '@angular/core';
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

export class FlowchartRunManager {
  private readonly tracker = new RunPathTracker();
  private runSubscription: Subscription | null = null;
  private currentSocket: WebSocket | null = null;
  private currentMode: 'normal' | 'debug' | null = null;
  private paused = false;
  private bufferedEvents: unknown[] = [];

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

  handleRunEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    if (this.paused) {
      this.bufferedEvents.push(event);
      return;
    }
    this.processEvent(event as Record<string, unknown>);
  }

  private processEvent(payload: Record<string, unknown>): void {
    const type = String((payload as { type?: unknown }).type ?? '');
    switch (type) {
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
}
