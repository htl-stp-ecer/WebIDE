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
  shouldSimulate?(): boolean;
}

export interface StepTiming {
  id: string;
  index: number;
  label?: string;
  path?: string;
  signature?: string;
  durationMs: number;
  timestampMs: number;
  elapsedMs: number;
  runId: number;
  anomaly?: boolean;
  expectedMeanMs?: number;
  expectedStddevMs?: number;
  deviationSigma?: number;
  source: 'synthetic' | 'measured';
}

type RunLogStream = 'stdout' | 'stderr' | 'system';

export interface RunLogEntry {
  id: number;
  stream: RunLogStream;
  line: string;
  timestampMs: number;
  runId: number;
}

const MAX_LOG_ENTRIES = 1500;

export class FlowchartRunManager {
  private static readonly HISTORY_RUN_ID = -1;

  private readonly tracker = new RunPathTracker();
  private runSubscription: Subscription | null = null;
  private currentSocket: WebSocket | null = null;
  private currentMode: 'normal' | 'debug' | null = null;
  private paused = false;
  private bufferedEvents: unknown[] = [];
  private currentRunId = 0;
  private awaitingRunStart = false;
  private runStartMs: number | null = null;
  private lastStepTimestampMs: number | null = null;
  private pathToNodeId: Map<string, string> = new Map();
  private accumulatedMs = 0;
  private logSequence = 0;

  readonly stepTimings = signal<StepTiming[]>([]);
  readonly maxStepDurationMs = signal(0);
  readonly nodeTimings = signal<Map<string, StepTiming>>(new Map());
  readonly logEntries = signal<RunLogEntry[]>([]);

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

  clearLogs(): void {
    this.logEntries.set([]);
    this.logSequence = 0;
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
        this.appendSystemLog(`Run started (pid ${String((payload as { pid?: unknown }).pid ?? '?')})`, payload);
        break;
      case 'open':
        this.ctx.isRunActive.set(true);
        if (this.currentMode === 'debug') {
          this.ctx.debugState.set('running');
          this.ctx.breakpointInfo.set(null);
        }
        break;
      case 'stdout':
        this.appendLogLine('stdout', (payload as { line?: unknown }).line, payload);
        break;
      case 'stderr':
        this.appendLogLine('stderr', (payload as { line?: unknown }).line, payload);
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
      case 'step_timing':
        this.applyMeasuredTiming(payload);
        break;
      case 'step_timing_status':
        // Timings database not present yet (expected in simulation); ignore.
        break;
      case 'step_timing_error':
        console.warn('[Flowchart] Step timing error', payload);
        break;
      case 'exit':
        this.appendSystemLog(`Run exited with code ${String((payload as { returncode?: unknown }).returncode ?? '?')}`, payload);
        this.ctx.isRunActive.set(false);
        this.resetDebugState();
        break;
      case 'error':
        if (type === 'error') {
          const message = (payload as { message?: unknown }).message;
          if (message) {
            this.appendLogLine('system', `Error: ${String(message)}`, payload);
          }
        }
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

  private appendSystemLog(message: string, payload?: Record<string, unknown>): void {
    this.appendLogLine('system', message, payload);
  }

  private appendLogLine(stream: RunLogStream, line: unknown, payload?: Record<string, unknown>): void {
    const text = line === undefined || line === null ? '' : String(line);
    const timestampMs = payload ? this.extractTimestampMs(payload) ?? Date.now() : Date.now();
    const lines = text.split(/\r?\n/);
    if (!lines.length) {
      this.appendLogEntry(stream, '', timestampMs);
      return;
    }
    for (const entry of lines) {
      this.appendLogEntry(stream, entry, timestampMs);
    }
  }

  private appendLogEntry(stream: RunLogStream, line: string, timestampMs: number): void {
    const entry: RunLogEntry = {
      id: ++this.logSequence,
      stream,
      line,
      timestampMs,
      runId: this.currentRunId,
    };
    this.logEntries.update(prev => {
      const next = [...prev, entry];
      if (next.length > MAX_LOG_ENTRIES) {
        next.splice(0, next.length - MAX_LOG_ENTRIES);
      }
      return next;
    });
  }

  stopRun(): void {
    const hadSubscription = !!this.runSubscription;
    const wasActive = this.ctx.isRunActive();
    if (!hadSubscription && !wasActive) return;

    this.runSubscription?.unsubscribe();
    this.runSubscription = null;
    this.ctx.isRunActive.set(false);
    this.resetDebugState();
    this.appendSystemLog('Run stopped by user');

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
    this.clearLogs();
    this.currentRunId += 1;
    this.awaitingRunStart = true;
    this.resetTimingData();
    this.ctx.isRunActive.set(true);
    this.ctx.debugState.set('idle');
    this.ctx.breakpointInfo.set(null);
    this.currentMode = mode;
    this.updateSocket(null);
    this.paused = false;
    this.bufferedEvents = [];

    const simulate = mode === 'debug' ? true : !!this.ctx.shouldSimulate?.();
    const runOptions = mode === 'debug'
      ? { simulate: true, debug: true, onSocket: (socket: WebSocket | null) => this.updateSocket(socket) }
      : { simulate, onSocket: (socket: WebSocket | null) => this.updateSocket(socket) };

    this.runSubscription = this.ctx.http.runMission(projectId, missionKey, runOptions).subscribe({
      next: event => this.handleRunEvent(event),
      error: err => {
        console.error('Mission run failed', err);
        this.appendSystemLog('Mission run failed');
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
    this.beginRun(ts);
  }

  private recordStepTiming(payload: Record<string, unknown>): void {
    const tsMs = this.extractTimestampMs(payload) ?? Date.now();
    if (this.awaitingRunStart || this.runStartMs === null) {
      this.beginRun(tsMs);
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
      runId: this.currentRunId,
      source: 'synthetic',
    };

    this.rebuildTimings([...this.stepTimings(), entry]);
  }

  private applyMeasuredTiming(payload: Record<string, unknown>): void {
    const durationSeconds = Number((payload as { duration_seconds?: unknown }).duration_seconds);
    if (!Number.isFinite(durationSeconds)) {
      return;
    }
    const durationMs = Math.max(0, durationSeconds * 1000);
    const recordedAtMs = this.extractRecordedAtMs(payload) ?? Date.now();

    const belongsToCurrentRun = this.isMeasuredTimingForCurrentRun(recordedAtMs);
    const runId = belongsToCurrentRun ? this.currentRunId : FlowchartRunManager.HISTORY_RUN_ID;

    const signatureRaw = (payload as { signature?: unknown }).signature;
    const signature = typeof signatureRaw === 'string' ? signatureRaw : undefined;
    const anomaly = Boolean((payload as { anomaly?: unknown }).anomaly);
    const expectedMeanMs = this.toMs((payload as { expected_mean?: unknown }).expected_mean);
    const expectedStddevMs = this.toMs((payload as { expected_stddev?: unknown }).expected_stddev);
    const deviationSigma = this.toNumber((payload as { deviation_sigma?: unknown }).deviation_sigma);

    if (!belongsToCurrentRun) {
      const entry: StepTiming = {
        id: `history-${recordedAtMs}-${signature ?? 'unknown'}`,
        index: this.stepTimings().length + 1,
        label: signature,
        signature,
        path: undefined,
        durationMs,
        timestampMs: recordedAtMs,
        elapsedMs: 0,
        runId,
        anomaly,
        expectedMeanMs,
        expectedStddevMs,
        deviationSigma,
        source: 'measured',
      };
      this.rebuildTimings([...this.stepTimings(), entry]);
      return;
    }

    if (this.awaitingRunStart || this.runStartMs === null) {
      this.beginRun(recordedAtMs);
    }

    const timings = [...this.stepTimings()];
    const targetIdx = this.findTimingTargetIndex(timings, runId, signature);
    const base: StepTiming = timings[targetIdx] ?? {
      id: '',
      index: targetIdx + 1,
      label: signature,
      path: undefined,
      signature,
      durationMs,
      timestampMs: recordedAtMs,
      elapsedMs: 0,
      runId,
      source: 'measured',
    };

    const merged: StepTiming = {
      ...base,
      id: base.id || `step-${targetIdx + 1}-${signature || base.path || 'measured'}`,
      durationMs,
      timestampMs: recordedAtMs,
      signature: signature ?? base.signature,
      label: base.label || signature,
      anomaly,
      expectedMeanMs: expectedMeanMs ?? base.expectedMeanMs,
      expectedStddevMs: expectedStddevMs ?? base.expectedStddevMs,
      deviationSigma: deviationSigma ?? base.deviationSigma,
      runId,
      source: 'measured',
    };

    timings[targetIdx] = merged;
    this.rebuildTimings(timings);
  }

  private findTimingTargetIndex(timings: StepTiming[], runId: number, signature?: string): number {
    const normalizedSig = (signature ?? '').trim().toLowerCase();

    if (normalizedSig) {
      for (let i = timings.length - 1; i >= 0; i--) {
        const t = timings[i];
        if (t.runId !== runId) continue;
        if (t.source !== 'measured' && this.matchesSignature(t, normalizedSig)) {
          return i;
        }
      }
    }

    for (let i = timings.length - 1; i >= 0; i--) {
      const t = timings[i];
      if (t.runId === runId && t.source !== 'measured') {
        return i;
      }
    }

    return timings.length;
  }

  private matchesSignature(entry: StepTiming, normalizedSig: string): boolean {
    const candidates = [
      entry.signature,
      entry.label,
      entry.path,
    ]
      .filter(Boolean)
      .map(v => String(v).toLowerCase());

    return candidates.some(val => val.includes(normalizedSig) || normalizedSig.includes(val));
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

  private extractRecordedAtMs(payload: Record<string, unknown>): number | null {
    const raw = (payload as { recorded_at?: unknown }).recorded_at;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw * 1000;
    }
    return this.extractTimestampMs(payload);
  }

  private toMs(value: unknown): number | undefined {
    const num = Number(value);
    if (!Number.isFinite(num)) return undefined;
    return num * 1000;
  }

  private toNumber(value: unknown): number | undefined {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }

  private rebuildTimings(nextTimings: StepTiming[]): void {
    let overallElapsed = 0;
    let currentRunElapsed = 0;
    let runElapsed = 0;
    let maxDuration = 0;
    const normalized: StepTiming[] = nextTimings.map((timing, idx) => {
      const duration = Number.isFinite(timing.durationMs) ? Math.max(0, timing.durationMs) : 0;
      overallElapsed += duration;
      const inCurrentRun = timing.runId === this.currentRunId;
      if (inCurrentRun) {
        runElapsed += duration;
        currentRunElapsed = runElapsed;
      }
      maxDuration = Math.max(maxDuration, duration);
      return {
        ...timing,
        id: timing.id || `step-${idx + 1}-${timing.path || timing.label || timing.signature || 'step'}`,
        index: timing.index || idx + 1,
        durationMs: duration,
        elapsedMs: inCurrentRun ? runElapsed : overallElapsed,
        runId: timing.runId ?? this.currentRunId,
        source: timing.source ?? 'synthetic',
      };
    });

    this.stepTimings.set(normalized);
    this.maxStepDurationMs.set(maxDuration);

    const nodeMap = new Map<string, StepTiming>();
    for (let i = normalized.length - 1; i >= 0; i--) {
      const timing = normalized[i];
      if (timing.runId !== this.currentRunId) continue;
      if (!timing.path) continue;
      const nodeId = this.pathToNodeId.get(timing.path);
      if (nodeId && !nodeMap.has(nodeId)) {
        nodeMap.set(nodeId, timing);
      }
    }
    this.nodeTimings.set(nodeMap);
    this.accumulatedMs = currentRunElapsed;
  }

  private isMeasuredTimingForCurrentRun(recordedAtMs: number): boolean {
    if (this.runStartMs === null) {
      return false;
    }
    return recordedAtMs >= this.runStartMs;
  }

  private resetTimingData(): void {
    this.runStartMs = null;
    this.lastStepTimestampMs = null;
    this.nodeTimings.set(new Map());
    this.accumulatedMs = 0;
  }

  private beginRun(startTimestampMs: number | null): void {
    this.runStartMs = startTimestampMs;
    this.awaitingRunStart = false;
    this.lastStepTimestampMs = null;
    this.accumulatedMs = 0;
  }
}
