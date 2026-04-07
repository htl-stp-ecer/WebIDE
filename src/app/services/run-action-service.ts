import { Injectable, signal } from '@angular/core';

type DebugState = 'idle' | 'running' | 'paused';

@Injectable({ providedIn: 'root' })
export class RunActionService {
  readonly isRunActive = signal(false);
  readonly debugState = signal<DebugState>('idle');

  private onRunFn: ((mode: 'normal' | 'debug') => void) | null = null;
  private onStopFn: (() => void) | null = null;
  private onContinueDebugFn: (() => void) | null = null;

  register(handlers: {
    onRun: (mode: 'normal' | 'debug') => void;
    onStop: () => void;
    onContinueDebug: () => void;
  }): void {
    this.onRunFn = handlers.onRun;
    this.onStopFn = handlers.onStop;
    this.onContinueDebugFn = handlers.onContinueDebug;
  }

  unregister(): void {
    this.onRunFn = null;
    this.onStopFn = null;
    this.onContinueDebugFn = null;
    this.isRunActive.set(false);
    this.debugState.set('idle');
  }

  run(mode: 'normal' | 'debug'): void {
    this.onRunFn?.(mode);
  }

  stop(): void {
    this.onStopFn?.();
  }

  continueDebug(): void {
    this.onContinueDebugFn?.();
  }
}
