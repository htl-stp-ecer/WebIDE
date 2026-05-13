import { Injectable, signal, effect } from '@angular/core';

type DebugState = 'idle' | 'running' | 'paused';

export type RunTarget = 'simulated' | 'real';

export type RunLogStream = 'stdout' | 'stderr' | 'system' | 'info' | 'warn' | 'error' | 'step';

export interface RunLogEntry {
  id: number;
  stream: RunLogStream;
  line: string;
  timestampMs: number;
  runId: number;
}

const RUN_TARGET_STORAGE_KEY = 'raccoon.runTarget';
const MAX_LOG_ENTRIES = 1500;

function loadInitialTarget(): RunTarget {
  if (typeof window === 'undefined') return 'simulated';
  try {
    const stored = window.localStorage.getItem(RUN_TARGET_STORAGE_KEY);
    if (stored === 'simulated' || stored === 'real') return stored;
  } catch {
    // localStorage may be unavailable; fall through.
  }
  return 'simulated';
}

@Injectable({ providedIn: 'root' })
export class RunActionService {
  readonly isRunActive = signal(false);
  readonly debugState = signal<DebugState>('idle');

  /**
   * IntelliJ-style "run configuration": picks where the start button sends
   * its work. `simulated` runs the whole project under the libstp sim;
   * `real` runs `raccoon run` on the laptop (talks to the wombat when
   * connected). Persisted to localStorage so it sticks across reloads.
   */
  readonly runTarget = signal<RunTarget>(loadInitialTarget());

  /**
   * Owns the in-memory log buffer. Lives on the root-provided service so
   * the bottom Logs panel keeps showing run output even when the Flowchart
   * component (and its FlowchartRunManager) gets torn down — for example
   * when the user flips to Code view.
   */
  readonly logEntries = signal<RunLogEntry[]>([]);
  private logSequence = 0;
  private currentRunId = 0;

  appendLogEntry(stream: RunLogStream, line: string, timestampMs: number): void {
    const entry: RunLogEntry = {
      id: ++this.logSequence,
      stream,
      line,
      timestampMs,
      runId: this.currentRunId,
    };
    console.debug('[RunAction] +log', stream, line.slice(0, 120));
    this.logEntries.update(prev => {
      const next = [...prev, entry];
      if (next.length > MAX_LOG_ENTRIES) {
        next.splice(0, next.length - MAX_LOG_ENTRIES);
      }
      return next;
    });
  }

  beginRun(): number {
    this.currentRunId += 1;
    this.logEntries.set([]);
    this.logSequence = 0;
    return this.currentRunId;
  }

  getCurrentRunId(): number {
    return this.currentRunId;
  }

  private onRunFn: ((mode: 'normal' | 'debug') => void) | null = null;
  private onStopFn: (() => void) | null = null;
  private onContinueDebugFn: (() => void) | null = null;

  constructor() {
    effect(() => {
      const value = this.runTarget();
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(RUN_TARGET_STORAGE_KEY, value);
      } catch {
        // ignore quota / private-mode errors
      }
    });
  }

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

  setRunTarget(target: RunTarget): void {
    this.runTarget.set(target);
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
