import { Injectable, signal, effect, computed } from '@angular/core';
import { RunConfiguration } from './http-service';

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
const RECORD_LOCALIZATION_STORAGE_KEY = 'raccoon.recordLocalization';
const SELECTED_CONFIG_STORAGE_KEY = 'raccoon.selectedRunConfig';
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

function loadInitialRecordLocalization(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(RECORD_LOCALIZATION_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function loadInitialSelectedConfig(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(SELECTED_CONFIG_STORAGE_KEY);
  } catch {
    return null;
  }
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

  /** Record localization data during real runs. Only meaningful when runTarget === 'real'. */
  readonly recordLocalization = signal<boolean>(loadInitialRecordLocalization());

  /**
   * Full PyCharm-style run-configuration list for the active project,
   * fetched from the IDE backend (which merges builtins + user entries
   * from raccoon.project.yml). Empty until a project is opened.
   */
  readonly runConfigurations = signal<RunConfiguration[]>([]);

  /**
   * Name of the currently selected run configuration. ``null`` means
   * "no configuration picked yet" — the run buttons then fall back to
   * the legacy {@link runTarget} simulated/real toggle.
   */
  readonly selectedRunConfigName = signal<string | null>(loadInitialSelectedConfig());

  /** UUID of the project currently open in the project view, ``''`` otherwise. */
  readonly currentProjectUUID = signal<string>('');

  readonly selectedRunConfig = computed<RunConfiguration | null>(() => {
    const name = this.selectedRunConfigName();
    if (!name) return null;
    return this.runConfigurations().find(c => c.name === name) ?? null;
  });

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
    effect(() => {
      const value = this.recordLocalization();
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(RECORD_LOCALIZATION_STORAGE_KEY, value ? '1' : '0');
      } catch {
        // ignore quota / private-mode errors
      }
    });
    effect(() => {
      const value = this.selectedRunConfigName();
      if (typeof window === 'undefined') return;
      try {
        if (value) {
          window.localStorage.setItem(SELECTED_CONFIG_STORAGE_KEY, value);
        } else {
          window.localStorage.removeItem(SELECTED_CONFIG_STORAGE_KEY);
        }
      } catch {
        // ignore quota / private-mode errors
      }
    });
    // Mirror the selected configuration into the legacy runTarget +
    // recordLocalization signals so existing consumers (flowchart-run-
    // manager, navbar tooltip) keep working without modification.
    effect(() => {
      const cfg = this.selectedRunConfig();
      if (!cfg) return;
      this.runTarget.set(cfg.target === 'simulated' ? 'simulated' : 'real');
      this.recordLocalization.set(cfg.record_localization);
    });
  }

  setRunConfigurations(configs: RunConfiguration[]): void {
    this.runConfigurations.set(configs);
    // If the saved selection no longer exists (e.g. project switch),
    // fall back to the first builtin so the dropdown always shows something.
    const current = this.selectedRunConfigName();
    if (current && !configs.some(c => c.name === current)) {
      this.selectedRunConfigName.set(configs[0]?.name ?? null);
    } else if (!current && configs.length > 0) {
      this.selectedRunConfigName.set(configs[0].name);
    }
  }

  selectRunConfig(name: string | null): void {
    this.selectedRunConfigName.set(name);
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

  toggleRecordLocalization(): void {
    this.recordLocalization.update(v => !v);
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
