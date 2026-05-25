import { WritableSignal, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { HttpService } from '../../services/http-service';
import { RunActionService, RunLogEntry, RunLogStream } from '../../services/run-action-service';
import { RunPathTracker } from './run-path-tracker';
import { TableVisualizationService } from './table/services/table-visualization.service';
import { Pose2D, createPose } from './table/models';

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
  runAction: RunActionService;
  isRunActive: WritableSignal<boolean>;
  debugState: WritableSignal<DebugState>;
  breakpointInfo: WritableSignal<BreakpointEventPayload | null>;
  getProjectUUID(): string | null;
  getMissionKey(): string | null;
  shouldSimulate?(): boolean;
  /**
   * Optional sim mode selector. `'fast'` (default) uses the heuristic
   * simulation; `'real'` runs the libstp simulator subprocess and emits
   * `sim_pose` events that this manager accumulates for live rendering.
   */
  simulationMode?(): 'fast' | 'real';
  /**
   * IntelliJ-style run target. `'simulated'` runs the *whole project* in
   * the libstp simulator (no mission name). `'real'` runs ``raccoon run``
   * (the wombat path) for all missions. Falls back to the legacy
   * shouldSimulate/simulationMode pair when undefined.
   */
  runTarget?(): 'simulated' | 'real';
  /** Whether to record localization data during real runs. */
  recordLocalization?(): boolean;
  /** Name of the active PyCharm-style run configuration, if any. */
  runConfigName?(): string | null;
  /** Called after a real run that produced a recording. */
  onRunRecorded?(projectUuid: string, runId: string): void;
  /** Optional sink for live pose samples — drawn by TableVisualizationPanel. */
  tableViz?: TableVisualizationService;
}

export interface LiveSimPose {
  /** Seconds since the runner started emitting poses. */
  t: number;
  xCm: number;
  yCm: number;
  thetaRad: number;
  yawRate?: number;
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

// Re-export so existing callers that imported `RunLogEntry` from the run
// manager continue to compile after the move to RunActionService.
export type { RunLogEntry } from '../../services/run-action-service';

/**
 * Pattern that matches raccoon-lib's structured logger output:
 *   `YYYY-MM-DD HH:MM:SS |   0.123s | level    | source                       | message`
 * The pipe-separated columns are padded, so we trim each captured group.
 */
const RACCOON_LOG_RE = /^\s*(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\s*\|\s*([\d.]+s)\s*\|\s*(trace|debug|info|warning|warn|error|critical|fatal)\s*\|\s*([^|]*?)\s*\|\s*(.*)$/i;

const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

/**
 * Lines from the simulator that are pure runtime noise — they happen on every
 * run (often during interpreter shutdown) and have no diagnostic value, so we
 * drop them rather than scroll the actual log off-screen.
 */
const NOISE_SUBSTRINGS = [
  'pure virtual method called',
  'terminate called without an active exception',
];

/**
 * Detect uppercase severity keywords in unstructured stdout/stderr lines
 * (rich.Panel output, plain ``print("WARNING: ...")``, etc.) so they get
 * coloured the same way as raccoon-lib's structured logger output.
 *
 * Word boundaries on both sides guard against false positives like
 * "WARNING_THRESHOLD" or "errno".
 */
const KEYWORD_RE = {
  error: /\b(ERROR|CRITICAL|FATAL)\b/,
  warn: /\b(WARNING|WARN)\b/,
};

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
  /** Backwards-compat alias — log entries now live on RunActionService so the bottom panel keeps them when the flowchart unmounts. */
  get logEntries() { return this.ctx.runAction.logEntries; }

  /** Live trajectory captured from `sim_pose` events when running in real-sim mode. */
  readonly liveSimPoses = signal<LiveSimPose[]>([]);
  readonly liveSimActive = signal(false);
  readonly liveSimScene = signal<string | null>(null);

  /**
   * Cap on the in-memory pose buffer so a 30 min run at 20 Hz doesn't bloat
   * the signal. Beyond this we drop the oldest samples.
   */
  private static readonly MAX_LIVE_POSES = 8000;

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
    // Tell the tracker which mission's nodes the user is currently viewing
    // so it can drop step events from other missions during an all-
    // missions run.
    this.tracker.setCurrentMissionName(this.ctx.getMissionKey());
    this.pathToNodeId = new Map(pathToNodeId);
    this.nodeTimings.set(new Map());
  }

  /**
   * Discard everything captured during the current/previous run. Called at
   * the start of a fresh run so the user always sees a clean canvas. Do not
   * call this on mission-view changes — that would erase the highlights and
   * live trajectory the user expects to find when they come back.
   */
  clearRunVisuals(): void {
    this.tracker.reset();
    this.liveSimPoses.set([]);
    this.liveSimActive.set(false);
    this.liveSimScene.set(null);
    this.ctx.tableViz?.clearLiveTrajectory();
  }

  private appendLiveSimPose(payload: Record<string, unknown>): void {
    const xCm = Number((payload as { x_cm?: unknown }).x_cm);
    const yCm = Number((payload as { y_cm?: unknown }).y_cm);
    const theta = Number((payload as { theta_rad?: unknown }).theta_rad);
    if (!Number.isFinite(xCm) || !Number.isFinite(yCm) || !Number.isFinite(theta)) {
      return;
    }
    const t = Number((payload as { t?: unknown }).t ?? 0);
    const yawRaw = (payload as { yaw_rate?: unknown }).yaw_rate;
    const yawRate = typeof yawRaw === 'number' && Number.isFinite(yawRaw) ? yawRaw : undefined;
    this.liveSimPoses.update(prev => {
      const next = prev.length >= FlowchartRunManager.MAX_LIVE_POSES
        ? prev.slice(prev.length - FlowchartRunManager.MAX_LIVE_POSES + 1)
        : prev.slice();
      next.push({ t: Number.isFinite(t) ? t : 0, xCm, yCm, thetaRad: theta, yawRate });
      return next;
    });

    // Mirror into the shared visualization service so the table panel can
    // render the live trajectory + a live current-pose marker.
    const viz = this.ctx.tableViz;
    if (viz) {
      // theta is in radians; createPose expects degrees per the existing service.
      const pose: Pose2D = createPose(xCm, yCm, (theta * 180) / Math.PI);
      viz.setCurrentPose(pose);
      const trail = viz.liveTrajectory().slice();
      if (trail.length >= FlowchartRunManager.MAX_LIVE_POSES) {
        trail.splice(0, trail.length - FlowchartRunManager.MAX_LIVE_POSES + 1);
      }
      trail.push(pose);
      viz.setLiveTrajectory(trail);
    }
  }

  clearLogs(): void {
    this.ctx.runAction.beginRun();
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

  getVisibleStepTimings(): StepTiming[] {
    const pathMap = this.pathToNodeId;
    return this.stepTimings().filter(timing => !!timing.path && pathMap.has(timing.path));
  }

  getVisibleMaxDurationMs(): number {
    let max = 0;
    for (const timing of this.getVisibleStepTimings()) {
      if (timing.durationMs > max) max = timing.durationMs;
    }
    return max;
  }

  handleRunEvent(event: unknown): void {
    if (!event || typeof event !== 'object') {
      console.debug('[RunManager] discard non-object event', event);
      return;
    }
    if (this.paused) {
      console.debug('[RunManager] paused, buffer event', (event as { type?: unknown }).type);
      this.bufferedEvents.push(event);
      return;
    }
    const type = (event as { type?: unknown }).type;
    if (type === 'stdout' || type === 'stderr') {
      console.debug('[RunManager] log event', type, (event as { line?: unknown }).line);
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
        this.logStepEvent(payload);
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
      case 'sim_started':
        this.liveSimActive.set(true);
        this.liveSimPoses.set([]);
        this.ctx.tableViz?.clearLiveTrajectory();
        this.ctx.tableViz?.setLiveTrajectoryActive(true);
        {
          const scene = (payload as { scene?: unknown }).scene;
          this.liveSimScene.set(typeof scene === 'string' ? scene : null);
          this.appendSystemLog(`Sim attached (scene: ${typeof scene === 'string' ? scene : 'unknown'})`, payload);
        }
        break;
      case 'sim_pose':
        this.appendLiveSimPose(payload);
        break;
      case 'mission_started':
        {
          const name = (payload as { mission_name?: unknown }).mission_name;
          if (typeof name === 'string') {
            this.appendSystemLog(`▶ Mission: ${name}`, payload);
          }
        }
        break;
      case 'mission_finished':
        {
          const name = (payload as { mission_name?: unknown }).mission_name;
          if (typeof name === 'string') {
            this.appendSystemLog(`✓ Mission: ${name}`, payload);
          }
        }
        break;
      case 'sim_pose_error':
        console.warn('[Flowchart] sim pose poller error', payload);
        break;
      case 'sim_error':
        {
          const message = (payload as { message?: unknown }).message;
          if (message) {
            this.appendLogLine('stderr', `[sim] ${String(message)}`, payload);
          }
        }
        break;
      case 'sim_finished':
        this.liveSimActive.set(false);
        this.ctx.tableViz?.setLiveTrajectoryActive(false);
        this.appendSystemLog(`Sim finished (exit ${String((payload as { exit_code?: unknown }).exit_code ?? '?')})`, payload);
        break;
      case 'step_timing_error':
        console.warn('[Flowchart] Step timing error', payload);
        break;
      case 'exit':
        this.appendSystemLog(`Run exited with code ${String((payload as { returncode?: unknown }).returncode ?? '?')}`, payload);
        this.ctx.isRunActive.set(false);
        this.resetDebugState();
        break;
      case 'run_recorded':
        {
          const runId = (payload as { run_id?: unknown }).run_id;
          const projectUuid = this.ctx.getProjectUUID();
          if (typeof runId === 'string' && projectUuid) {
            this.appendSystemLog(`Recording saved (run id: ${runId})`);
            this.ctx.onRunRecorded?.(projectUuid, runId);
          }
        }
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

  /**
   * Surface a ``step`` event in the logs tab so the user can follow execution
   * without staring at the flowchart. Real-sim emits one event per leaf
   * step; fast-sim emits per scheduled timeline entry — both reach this path
   * unchanged.
   */
  private logStepEvent(payload: Record<string, unknown>): void {
    const label = (payload['display_label'] as string)
      || (payload['function_name'] as string)
      || (payload['name'] as string)
      || (payload['step_type'] as string)
      || 'step';
    const path = Array.isArray(payload['path'])
      ? (payload['path'] as unknown[]).join('.')
      : undefined;
    const mission = typeof payload['mission_name'] === 'string'
      ? payload['mission_name'] as string
      : undefined;

    const prefixParts: string[] = [];
    if (mission) prefixParts.push(mission);
    if (path) prefixParts.push(path);
    const prefix = prefixParts.length ? prefixParts.join(' › ') : '';
    const text = prefix ? `${prefix} › ${label}` : label;
    this.appendLogLine('step', text, payload);
  }

  private appendLogLine(stream: RunLogStream, line: unknown, payload?: Record<string, unknown>): void {
    const raw = line === undefined || line === null ? '' : String(line);
    const timestampMs = payload ? this.extractTimestampMs(payload) ?? Date.now() : Date.now();
    const lines = raw.split(/\r?\n/);
    if (!lines.length) {
      this.appendLogEntry(stream, '', timestampMs);
      return;
    }
    for (const entry of lines) {
      this.ingestLine(stream, entry, timestampMs);
    }
  }

  /**
   * Normalize one log line before it lands in the panel: strip ANSI codes,
   * skip known noise, and demote raccoon-lib's bare ``TIME | LEVEL | SRC |
   * MSG`` format into a cleaner ``[src] msg`` line routed to the matching
   * info/warn/error stream so the panel can colour it.
   */
  private ingestLine(stream: RunLogStream, rawLine: string, fallbackTs: number): void {
    // Strip ANSI, trailing whitespace, and collapse the long runs of padding
    // spaces that rich.Panel produces when warnings/errors get boxed.
    let cleaned = rawLine.replace(ANSI_ESCAPE_RE, '').replace(/\s+$/g, '');
    if (!cleaned) {
      console.debug('[RunManager] drop empty line after clean', { rawLine });
      return;
    }

    for (const needle of NOISE_SUBSTRINGS) {
      if (cleaned.includes(needle)) {
        console.debug('[RunManager] drop noise', needle, cleaned.slice(0, 80));
        return;
      }
    }

    // raccoon-lib structured logger format → split into source + message,
    // route to the matching severity stream.
    const match = cleaned.match(RACCOON_LOG_RE);
    if (match) {
      const level = match[3].toLowerCase();
      const source = match[4].trim();
      const message = match[5].trim();
      let mapped: RunLogStream = 'info';
      if (level === 'warn' || level === 'warning') mapped = 'warn';
      else if (level === 'error' || level === 'critical' || level === 'fatal') mapped = 'error';
      else if (level === 'trace' || level === 'debug') mapped = 'info';
      const text = source ? `[${source}] ${message}` : message;
      const parsedTs = Date.parse(match[1]);
      this.appendLogEntry(mapped, text, Number.isFinite(parsedTs) ? parsedTs : fallbackTs);
      return;
    }

    // Collapse rich.Panel-style long runs of padding spaces inside the line
    // so warnings rendered as boxed panels read as a single colored line in
    // the panel instead of a "where did it go?" wall of whitespace.
    const compact = cleaned.replace(/\s{2,}/g, ' ').trim();
    if (!compact) return;

    // Unstructured stdout/stderr — promote the stream to warn/error when the
    // line contains an obvious severity keyword (rich.Panel output, plain
    // ``print("ERROR: …")``, etc.).
    let mapped = stream;
    if (stream === 'stdout' || stream === 'stderr') {
      if (KEYWORD_RE.error.test(compact)) mapped = 'error';
      else if (KEYWORD_RE.warn.test(compact)) mapped = 'warn';
      // stderr without a severity keyword stays red — leave stream as-is.
    }
    this.appendLogEntry(mapped, compact, fallbackTs);
  }

  private appendLogEntry(stream: RunLogStream, line: string, timestampMs: number): void {
    this.ctx.runAction.appendLogEntry(stream, line, timestampMs);
  }

  private formatRunError(err: unknown): string {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (err instanceof Error) return err.message || String(err);
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
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
    // Whole-project run targets only need a project id. Debug + per-mission
    // fast sim still require a focused mission.
    const target = this.ctx.runTarget?.() ?? 'simulated';
    const needsMission = mode === 'debug' || (target !== 'simulated' && target !== 'real');
    if (!projectId || (needsMission && !missionKey)) {
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

    // Decide what to launch based on the navbar run-target dropdown.
    // simulated -> whole-project libstp run (missionKey ignored)
    // real      -> raccoon run on the laptop (whole project)
    // debug     -> fast heuristic sim of the visible mission (legacy path)
    let simulate: boolean | 'fast' | 'real';
    let runMissionKey: string | null = missionKey;

    if (mode === 'debug') {
      simulate = 'fast';
    } else if (target === 'simulated') {
      simulate = 'real';
      runMissionKey = null; // whole project
    } else {
      simulate = false;
      runMissionKey = null; // whole project on real target
    }

    const recordLocalization = target === 'real' && mode !== 'debug' && (this.ctx.recordLocalization?.() ?? false);
    const runConfig = mode === 'debug' ? null : (this.ctx.runConfigName?.() ?? null);
    const runOptions = mode === 'debug'
      ? { simulate, debug: true, onSocket: (socket: WebSocket | null) => this.updateSocket(socket) }
      : { simulate, recordLocalization, runConfig, onSocket: (socket: WebSocket | null) => this.updateSocket(socket) };

    this.runSubscription = this.ctx.http.runMission(projectId, runMissionKey, runOptions).subscribe({
      next: event => this.handleRunEvent(event),
      error: err => {
        console.error('Mission run failed', err);
        this.appendSystemLog(`Mission run failed: ${this.formatRunError(err)}`);
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
