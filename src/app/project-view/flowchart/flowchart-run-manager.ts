import { WritableSignal } from '@angular/core';
import { Subscription } from 'rxjs';
import { HttpService } from '../../services/http-service';
import { RunPathTracker } from './run-path-tracker';

interface FlowchartRunContext {
  http: HttpService;
  isRunActive: WritableSignal<boolean>;
  getProjectUUID(): string | null;
  getMissionKey(): string | null;
}

export class FlowchartRunManager {
  private readonly tracker = new RunPathTracker();
  private runSubscription: Subscription | null = null;

  constructor(private readonly ctx: FlowchartRunContext) {}

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
    switch ((event as any).type) {
      case 'open':
        this.ctx.isRunActive.set(true);
        break;
      case 'planned_steps':
        this.tracker.cachePlannedSteps(event);
        break;
      case 'step':
        this.tracker.handleStepEvent(event);
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
    if (!hadSubscription && !wasActive) return;

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
    if (mode !== 'normal') {
      console.log('Debug run requested');
      return;
    }

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
  }
}
