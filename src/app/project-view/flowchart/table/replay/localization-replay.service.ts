import { Injectable, computed, signal } from '@angular/core';
import { HttpService } from '../../../../services/http-service';

/** Header line of a libstp localization recording (RLREC v1). */
export interface ReplayHeader {
  format_version: number;
  started_at_unix_ns: number;
  tick_hz: number;
  record_hz: number;
  particle_count: number;
  units: {
    position: 'm' | 'cm' | string;
    heading: 'rad' | 'deg' | string;
    sensor_offset: 'cm' | 'm' | string;
  };
  robot: {
    width_cm?: number;
    length_cm?: number;
    sensors?: ReplaySensor[];
  };
  // Older recorder variants emit sensors at the top level.
  sensors?: ReplaySensor[];
  table_map?: unknown | null;
  notes?: string;
}

export interface ReplaySensor {
  name: string;
  kind: 'line' | 'wall' | string;
  forward_cm: number;
  strafe_cm: number;
}

/** [x, y, heading, weight] particle entry. */
export type ReplayParticle = [number, number, number, number];

export interface ReplayObservation {
  surface_kind: 'line' | 'wall' | string;
  detected: boolean;
  sensor_offset_cm: [number, number]; // [forward_cm, strafe_cm]
  sigma_cm?: number;
  measured_distance_cm?: number | null;
  pose?: [number, number, number] | null;
  pose_sigma?: [number, number, number] | null;
}

export interface ReplayFrame {
  t_ns: number;
  pose: [number, number, number];
  sigma?: [number, number, number];
  odom_delta?: number[];
  particles: ReplayParticle[];
  observations: ReplayObservation[];
  resampled: boolean;
}

/** Lightweight summary returned by the IDE backend's run listing endpoint. */
export interface RunSummary {
  run_id: string;
  /** ISO timestamp when the run started (UTC, e.g. "2026-05-23T14:30:12Z"). */
  started_at: string;
  has_localization: boolean;
  file_size_bytes: number;
  /** Duration of the recording in milliseconds. ``null`` until lazily computed. */
  duration_ms: number | null;
  /** Number of frames in the recording (header excluded). ``null`` until lazy. */
  frame_count: number | null;
}

/** Approx. browser refresh rate; we don't need to be exact. */
const RAF_HZ = 60;

@Injectable({ providedIn: 'root' })
export class LocalizationReplayService {
  private readonly _availableRuns = signal<RunSummary[]>([]);
  private readonly _loadedRunId = signal<string | null>(null);
  private readonly _loadedProjectUuid = signal<string | null>(null);
  private readonly _header = signal<ReplayHeader | null>(null);
  private readonly _frames = signal<ReplayFrame[]>([]);
  private readonly _currentFrameIndex = signal<number>(0);
  private readonly _isPlaying = signal<boolean>(false);
  private readonly _playbackSpeed = signal<number>(1.0);
  private readonly _loading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);
  private readonly _autoLoadRequest = signal<{ projectUuid: string; runId: string } | null>(null);

  readonly availableRuns = this._availableRuns.asReadonly();
  readonly loadedRunId = this._loadedRunId.asReadonly();
  readonly autoLoadRequest = this._autoLoadRequest.asReadonly();
  readonly header = this._header.asReadonly();
  readonly frames = this._frames.asReadonly();
  readonly currentFrameIndex = this._currentFrameIndex.asReadonly();
  readonly isPlaying = this._isPlaying.asReadonly();
  readonly playbackSpeed = this._playbackSpeed.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  readonly currentFrame = computed<ReplayFrame | null>(() => {
    const idx = this._currentFrameIndex();
    return this._frames()[idx] ?? null;
  });

  /** Frame poses from frame 0 up to currentFrameIndex (inclusive). */
  readonly trailUpToNow = computed<[number, number, number][]>(() => {
    const idx = this._currentFrameIndex();
    const frames = this._frames();
    const out: [number, number, number][] = [];
    const last = Math.min(idx, frames.length - 1);
    for (let i = 0; i <= last; i++) {
      const p = frames[i]?.pose;
      if (p) out.push(p);
    }
    return out;
  });

  private rafHandle: number | null = null;
  private frameAccumulator = 0;
  private lastRafTimestamp: number | null = null;

  constructor(private readonly http: HttpService) {}

  // ---- Listing ----

  async listRuns(projectUuid: string): Promise<void> {
    try {
      this._error.set(null);
      const url = this.localApi(`/runs/${encodeURIComponent(projectUuid)}`);
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) {
        this._availableRuns.set([]);
        return;
      }
      const runs = (await resp.json()) as RunSummary[];
      this._availableRuns.set(runs);
    } catch (err) {
      this._availableRuns.set([]);
      this._error.set(err instanceof Error ? err.message : String(err));
    }
  }

  // ---- Loading ----

  async loadRun(projectUuid: string, runId: string): Promise<void> {
    this.pause();
    this._loading.set(true);
    this._error.set(null);
    this._header.set(null);
    this._frames.set([]);
    this._currentFrameIndex.set(0);
    this._loadedRunId.set(null);
    this._loadedProjectUuid.set(null);

    try {
      const url = this.localApi(
        `/runs/${encodeURIComponent(projectUuid)}/${encodeURIComponent(runId)}/localization`,
      );
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok || !resp.body) {
        throw new Error(`Failed to load run (${resp.status})`);
      }

      const { header, frames } = await parseJsonlStream(resp.body);
      if (!header) {
        throw new Error('Recording is missing the header line.');
      }
      this._header.set(header);
      this._frames.set(frames);
      this._loadedRunId.set(runId);
      this._loadedProjectUuid.set(projectUuid);
      this._currentFrameIndex.set(0);
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : String(err));
      this._header.set(null);
      this._frames.set([]);
      this._loadedRunId.set(null);
      this._loadedProjectUuid.set(null);
    } finally {
      this._loading.set(false);
    }
  }

  unloadRun(): void {
    this.pause();
    this._header.set(null);
    this._frames.set([]);
    this._currentFrameIndex.set(0);
    this._loadedRunId.set(null);
    this._loadedProjectUuid.set(null);
    this._error.set(null);
  }

  requestAutoLoad(projectUuid: string, runId: string): void {
    this._autoLoadRequest.set({ projectUuid, runId });
  }

  clearAutoLoadRequest(): void {
    this._autoLoadRequest.set(null);
  }

  // ---- Playback ----

  play(): void {
    if (this._isPlaying()) return;
    if (this._frames().length === 0) return;
    // If we're at the very end, restart from 0.
    if (this._currentFrameIndex() >= this._frames().length - 1) {
      this._currentFrameIndex.set(0);
    }
    this._isPlaying.set(true);
    this.frameAccumulator = 0;
    this.lastRafTimestamp = null;
    this.startLoop();
  }

  pause(): void {
    this._isPlaying.set(false);
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.lastRafTimestamp = null;
  }

  togglePlay(): void {
    if (this._isPlaying()) this.pause();
    else this.play();
  }

  seek(frameIndex: number): void {
    const total = this._frames().length;
    if (total === 0) {
      this._currentFrameIndex.set(0);
      return;
    }
    const clamped = Math.max(0, Math.min(total - 1, Math.floor(frameIndex)));
    this._currentFrameIndex.set(clamped);
    this.frameAccumulator = 0;
  }

  step(direction: 1 | -1): void {
    this.pause();
    this.seek(this._currentFrameIndex() + direction);
  }

  setPlaybackSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) return;
    this._playbackSpeed.set(speed);
  }

  // ---- Internal RAF loop ----

  private startLoop(): void {
    const tick = (ts: number) => {
      if (!this._isPlaying()) {
        this.rafHandle = null;
        return;
      }

      const frames = this._frames();
      if (frames.length === 0) {
        this.pause();
        return;
      }

      // Time-based advance (drift-free): compute elapsed wall time
      // since last RAF and advance by speed * record_hz * elapsedSeconds.
      const header = this._header();
      const recordHz = header?.record_hz ?? 20.0;
      const speed = this._playbackSpeed();

      let elapsedS: number;
      if (this.lastRafTimestamp === null) {
        // First frame after play — pretend we ran 1 RAF tick so the user
        // sees motion immediately.
        elapsedS = 1 / RAF_HZ;
      } else {
        elapsedS = (ts - this.lastRafTimestamp) / 1000;
        // Cap big jumps (tab returning from background) so we don't skip
        // the entire run in one frame.
        if (elapsedS > 0.5) elapsedS = 0.5;
      }
      this.lastRafTimestamp = ts;

      this.frameAccumulator += elapsedS * recordHz * speed;
      const advance = Math.floor(this.frameAccumulator);
      if (advance > 0) {
        this.frameAccumulator -= advance;
        const next = this._currentFrameIndex() + advance;
        if (next >= frames.length - 1) {
          this._currentFrameIndex.set(frames.length - 1);
          this.pause();
          return;
        }
        this._currentFrameIndex.set(next);
      }

      this.rafHandle = requestAnimationFrame(tick);
    };

    this.rafHandle = requestAnimationFrame(tick);
  }

  // ---- URL helper ----

  private localApi(path: string): string {
    const port = this.http.getLocalBackendPort();
    if (port) {
      const base = new URL(window.location.origin);
      base.port = port;
      return `${base.protocol}//${base.host}/api/v1${path}`;
    }
    return `/api/v1${path}`;
  }
}

// ---- JSONL parser (exported for tests) ----

export interface ParsedRecording {
  header: ReplayHeader | null;
  frames: ReplayFrame[];
}

/**
 * Streams a ReadableStream<Uint8Array> and parses it as JSONL.
 * The first valid `{"kind":"header",...}` line is returned as the header.
 * Every subsequent `{"kind":"frame",...}` line is appended to frames.
 * A partial last line is silently dropped (matches recorder contract).
 *
 * We stream rather than `.text()` so multi-MB recordings don't block
 * the main thread for hundreds of ms while the response buffers.
 */
export async function parseJsonlStream(body: ReadableStream<Uint8Array>): Promise<ParsedRecording> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let header: ReplayHeader | null = null;
  const frames: ReplayFrame[] = [];

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Skip malformed lines silently.
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.kind === 'header' && !header) {
      header = parsed as ReplayHeader;
    } else if (parsed.kind === 'frame') {
      frames.push(parsed as ReplayFrame);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      consumeLine(line);
    }
  }

  // Flush remaining buffered text. Per recording contract a partial last
  // line is dropped — JSON.parse failure inside consumeLine handles that.
  buffer += decoder.decode();
  if (buffer.length > 0) consumeLine(buffer);

  return { header, frames };
}
