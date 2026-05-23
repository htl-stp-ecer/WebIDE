import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, map, Observable } from 'rxjs';
import {Mission} from '../entities/Mission';
import { TypeDefinition } from '../entities/TypeDefinition';
import { MissionSimulationData, ProjectSimulationData } from '../entities/Simulation';

/** A single drawn line or wall segment, in table coordinates (cm). */
export interface TableMapLine {
  kind: 'line' | 'wall';
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  widthCm: number;
}

/** Edge geometry of a transition portal/ramp on one layer. */
export interface TableMapTransitionEdge {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/**
 * A transition (ramp/portal) connecting two layers along a line on each layer.
 * The two edges should have approximately equal length — the parameter t along
 * the edge maps 1:1 between layers.
 */
export interface TableMapTransition {
  id: string;
  name?: string;
  fromLayer: string;
  toLayer: string;
  from: TableMapTransitionEdge;
  to: TableMapTransitionEdge;
  /** If true (default) the transition is usable in both directions. */
  bidirectional?: boolean;
  /** Cost multiplier (1 = normal travel). Default 1. */
  costMultiplier?: number;
  /** Effective ramp width for clearance checks. */
  widthCm?: number;
}

/** One stacked level of the table (e.g. ground floor, upper floor). */
export interface TableMapLayer {
  id: string;
  name: string;
  /** Optional z-height for visualization (cm). Defaults to layer index * 10. */
  zCm?: number;
  lines: TableMapLine[];
}

/** Current persistent format with stacked layers and inter-layer transitions. */
export interface TableMapFileV2 {
  format: 'flowchart-table-map';
  version: 2;
  table: { widthCm: number; heightCm: number };
  layers: TableMapLayer[];
  transitions: TableMapTransition[];
  /** Last-edited layer id (UI hint, optional). */
  activeLayerId?: string;
}

/** Legacy single-layer format. Still accepted on read for backwards compatibility. */
export interface TableMapFileV1 {
  format: 'flowchart-table-map';
  version: 1;
  table: { widthCm: number; heightCm: number };
  lines: TableMapLine[];
}

/** Either supported format. Loaders should accept this and normalize via `migrateTableMap`. */
export type TableMapFile = TableMapFileV1 | TableMapFileV2;

export const DEFAULT_LAYER_ID = 'ground';
export const DEFAULT_LAYER_NAME = 'Ground';

/**
 * Normalize any accepted .ftmap shape to v2. v1 maps get wrapped into a single
 * default layer; v2 maps are returned as-is (with defensive defaults).
 */
export function migrateTableMap(file: TableMapFile | null | undefined): TableMapFileV2 | null {
  if (!file || file.format !== 'flowchart-table-map') return null;
  const table = file.table ?? { widthCm: 0, heightCm: 0 };

  if ((file as TableMapFileV2).version === 2) {
    const v2 = file as TableMapFileV2;
    const layers = Array.isArray(v2.layers) && v2.layers.length
      ? v2.layers.map((l, idx) => ({
          id: l.id || `layer-${idx}`,
          name: l.name || `Layer ${idx + 1}`,
          zCm: typeof l.zCm === 'number' ? l.zCm : idx * 10,
          lines: Array.isArray(l.lines) ? l.lines : [],
        }))
      : [{ id: DEFAULT_LAYER_ID, name: DEFAULT_LAYER_NAME, zCm: 0, lines: [] }];
    return {
      format: 'flowchart-table-map',
      version: 2,
      table,
      layers,
      transitions: Array.isArray(v2.transitions) ? v2.transitions : [],
      activeLayerId: v2.activeLayerId && layers.some(l => l.id === v2.activeLayerId)
        ? v2.activeLayerId
        : layers[0].id,
    };
  }

  // v1 → v2: wrap flat lines[] into a single default layer
  const v1 = file as TableMapFileV1;
  return {
    format: 'flowchart-table-map',
    version: 2,
    table,
    layers: [{
      id: DEFAULT_LAYER_ID,
      name: DEFAULT_LAYER_NAME,
      zCm: 0,
      lines: Array.isArray(v1.lines) ? v1.lines : [],
    }],
    transitions: [],
    activeLayerId: DEFAULT_LAYER_ID,
  };
}

export type SimulateMode = 'fast' | 'real';

interface RunMissionOptions {
  /**
   * Simulation mode for the run:
   *   - `false` or omitted: real hardware (run.sh)
   *   - `true` / `'fast'`: heuristic simulation (cheap, no robot logic)
   *   - `'real'`: spawn the libstp simulator and stream actual pose
   */
  simulate?: boolean | SimulateMode;
  debug?: boolean;
  onSocket?: (socket: WebSocket | null) => void;
}

interface DeviceProjectPayload {
  id?: string;
  uuid?: string;
  name: string;
  connection?: Project['connection'];
}

interface DeviceProjectListPayload {
  projects: DeviceProjectPayload[];
  count: number;
}

@Injectable({
  providedIn: 'root'
})
export class HttpService {
  private deviceBaseSubject = new BehaviorSubject<string>('');
  deviceBase$ = this.deviceBaseSubject.asObservable();
  private localBackendPort = '';
  private localBase = '';

  constructor(private http: HttpClient) {
    const savedPort = localStorage.getItem('localBackendPort');
    if (savedPort) {
      this.setLocalBackendPortInternal(savedPort, false);
    } else {
      const defaultPort = this.defaultFrontendPort();
      if (defaultPort) {
        this.setLocalBackendPortInternal(defaultPort, false);
      }
    }
  }

  setDeviceBase(ip: string) {
    let base = (ip || '').trim();
    try {
      if (!/^https?:\/\//i.test(base)) {
        base = 'http://' + base;
      }
      const u = new URL(base);
      if (!u.port) {
        u.port = '8421';
      }
      this.deviceBaseSubject.next(u.origin);
      // Fetch the API token from the public endpoint and cache it
      this.http.get<{token: string}>(`${u.origin}/api/v1/device/token`).subscribe({
        next: res => localStorage.setItem('raccoon_device_token', res.token),
        error: () => {},
      });
    } catch {
      this.deviceBaseSubject.next(base);
    }
  }

  setIp(ip: string) {
    this.setDeviceBase(ip);
  }

  clearDeviceBase() {
    this.deviceBaseSubject.next('');
  }

  getLocalBackendPort() {
    return this.localBackendPort;
  }

  setLocalBackendPort(port: string) {
    const trimmed = (port || '').trim();
    if (!trimmed) {
      localStorage.removeItem('localBackendPort');
      const defaultPort = this.defaultFrontendPort();
      if (defaultPort) {
        this.setLocalBackendPortInternal(defaultPort, false);
      } else {
        this.localBackendPort = '';
        this.localBase = '';
      }
      return;
    }

    const portNum = Number(trimmed);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      return;
    }

    this.localBackendPort = String(portNum);
    const baseUrl = new URL(window.location.origin);
    baseUrl.port = this.localBackendPort;
    this.localBase = `${baseUrl.protocol}//${baseUrl.host}`;
    localStorage.setItem('localBackendPort', this.localBackendPort);
  }

  private setLocalBackendPortInternal(port: string, persist: boolean) {
    const trimmed = (port || '').trim();
    if (!trimmed) {
      this.localBackendPort = '';
      this.localBase = '';
      if (persist) {
        localStorage.removeItem('localBackendPort');
      }
      return;
    }

    const portNum = Number(trimmed);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      return;
    }

    this.localBackendPort = String(portNum);
    const baseUrl = new URL(window.location.origin);
    baseUrl.port = this.localBackendPort;
    this.localBase = `${baseUrl.protocol}//${baseUrl.host}`;
    if (persist) {
      localStorage.setItem('localBackendPort', this.localBackendPort);
    }
  }

  private defaultFrontendPort() {
    // In development (npm run dev on port 4300), backend is on 4200
    if (window.location.port === '4300') {
      return '4200';
    }
    return window.location.port || '';
  }

  private get deviceBase() {
    return this.deviceBaseSubject.getValue();
  }

  private localApi(path: string) {
    if (this.localBase) {
      return `${this.localBase}/api/v1${path}`;
    }
    return `/api/v1${path}`;
  }

  private localApiAbsolute(path: string) {
    const url = this.localApi(path);
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    return `${window.location.origin}${url}`;
  }

  private deviceApi(path: string) {
    const base = this.deviceBase;
    if (!base) throw new Error('Device base not set!');
    return `${base}${path}`;
  }

  getDeviceInfo(ip: string) {
    return this.http.get<ConnectionInfo>(`${ip}/api/v1/device/info`);
  }

  getDeviceInfoDefault() {
    return this.http.get<ConnectionInfo>(this.deviceApi('/api/v1/device/info'));
  }

  changeHostname(newName: string) {
    return this.http.put<ConnectionInfo>(this.deviceApi('/api/v1/device/hostname'), { hostname: newName });
  }

  updateDeviceDimensions(widthCm: number, lengthCm: number) {
    return this.http.put<ConnectionInfo>(this.deviceApi('/api/v1/device/dimensions'), {
      width_cm: widthCm,
      length_cm: lengthCm,
    });
  }

  updateDeviceSensors(sensors: DeviceSensorInfo[]) {
    return this.http.put<ConnectionInfo>(this.deviceApi('/api/v1/device/sensors'), {
      sensors,
    });
  }

  updateDeviceRotationCenter(rotationCenter?: DeviceCenterPoint) {
    return this.http.put<ConnectionInfo>(this.deviceApi('/api/v1/device/rotation-center'), {
      rotation_center: rotationCenter,
    });
  }

  updateDeviceStartPose(startPose: { x_cm: number; y_cm: number; theta_deg: number }) {
    return this.http.put<ConnectionInfo>(this.deviceApi('/api/v1/device/start-pose'), {
      start_pose: startPose,
    });
  }

  // Local device API (for projects without Pi connection)
  getLocalDeviceInfo(projectUuid: string) {
    return this.http.get<ConnectionInfo>(this.localApi(`/device/${projectUuid}/info`));
  }

  updateLocalDeviceDimensions(projectUuid: string, widthCm: number, lengthCm: number) {
    return this.http.put<ConnectionInfo>(this.localApi(`/device/${projectUuid}/dimensions`), {
      width_cm: widthCm,
      length_cm: lengthCm,
    });
  }

  updateLocalDeviceSensors(projectUuid: string, sensors: DeviceSensorInfo[]) {
    return this.http.put<ConnectionInfo>(this.localApi(`/device/${projectUuid}/sensors`), {
      sensors,
    });
  }

  updateLocalDeviceRotationCenter(projectUuid: string, rotationCenter?: DeviceCenterPoint) {
    return this.http.put<ConnectionInfo>(this.localApi(`/device/${projectUuid}/rotation-center`), {
      rotation_center: rotationCenter,
    });
  }

  updateLocalDeviceStartPose(projectUuid: string, startPose: { x_cm: number; y_cm: number; theta_deg: number }) {
    return this.http.put<ConnectionInfo>(this.localApi(`/device/${projectUuid}/start-pose`), {
      start_pose: startPose,
    });
  }

  updateLocalDeviceKinematics(projectUuid: string, kinematics: { track_width_m?: number; wheelbase_m?: number; wheel_radius_m?: number }) {
    return this.http.put<ConnectionInfo>(this.localApi(`/device/${projectUuid}/kinematics`), kinematics);
  }

  getLocalTableMap(projectUuid: string) {
    return this.http.get<{ map: TableMapFile | null }>(this.localApi(`/device/${projectUuid}/table-map`));
  }

  saveLocalTableMap(projectUuid: string, mapData: TableMapFile) {
    return this.http.put<{ success: boolean }>(this.localApi(`/device/${projectUuid}/table-map`), mapData);
  }

  getAllProjects() {
    return this.http.get<Project[]>(this.localApi('/projects'));
  }

  getProject(uuid: string) {
    return this.http.get<Project>(this.localApi(`/projects/${uuid}`));
  }

  commandArm(projectUuid: string, joint_angles_deg: number[]) {
    return this.http.post<{ success: boolean; count: number }>(
      this.localApi(`/projects/${projectUuid}/arm/command`),
      { joint_angles_deg },
    );
  }

  getDeviceProjects() {
    return this.http
      .get<Project[] | DeviceProjectListPayload>(this.deviceApi('/api/v1/projects'))
      .pipe(map(response => this.normalizeDeviceProjects(response)));
  }

  createDeviceProject(name: string) {
    return this.http
      .post<Project | DeviceProjectPayload>(this.deviceApi('/api/v1/projects'), { name })
      .pipe(map(project => this.normalizeDeviceProject(project)));
  }

  deleteDeviceProject(uuid: string) {
    return this.http.delete(this.deviceApi(`/api/v1/projects/${uuid}`));
  }

  deleteProject(uuid: string) {
    return this.http.delete(this.localApi(`/projects/${uuid}`));
  }

  createProject(newProject: string) {
    return this.http.post<Project>(this.localApi('/projects'), { name: newProject });
  }

  getAllSteps(uuid: string) {
    return this.http.get<Step[]>(this.localApi(`/steps/?project_uuid=${uuid}`));
  }

  getStepIndexStatus() {
    return this.http.get<{ status: string; count?: number; last_indexed_at?: string; error?: string }>(
      this.localApi('/steps/index/status')
    );
  }

  refreshStepIndex(forceClear: boolean = false) {
    const query = forceClear ? '?force_clear=1' : '';
    return this.http.post<{ status: string; count?: number; last_indexed_at?: string; error?: string }>(
      this.localApi(`/steps/index/refresh${query}`),
      {}
    );
  }

  clearStepIndex() {
    return this.http.post<{ status: string; count?: number; last_indexed_at?: string; error?: string }>(
      this.localApi('/steps/index/clear'),
      {}
    );
  }

  getTypeDefinitions(projectUUID: string) {
    return this.http.get<TypeDefinition[]>(this.localApi(`/type-definitions/${projectUUID}`));
  }

  getMissionSimulationData(projectUUID: string, missionName: string) {
    const encoded = encodeURIComponent(missionName);
    return this.http.get<MissionSimulationData>(this.localApi(`/missions/${projectUUID}/simulation/${encoded}`));
  }

  getProjectSimulationData(projectUUID: string) {
    return this.http.get<ProjectSimulationData>(this.localApi(`/missions/${projectUUID}/simulation`));
  }

  getAllMissions(projectUUID: string) {
    return this.http.get<Mission[]>(this.localApi(`/missions/${projectUUID}`));
  }

  getMissionSource(projectUUID: string, missionName: string) {
    const encoded = encodeURIComponent(missionName);
    return this.http.get<{ name: string; source: string }>(
      this.localApi(`/missions/${projectUUID}/source/${encoded}`)
    );
  }

  saveMissionSource(projectUUID: string, missionName: string, source: string) {
    const encoded = encodeURIComponent(missionName);
    return this.http.put<{ success: boolean }>(
      this.localApi(`/missions/${projectUUID}/source/${encoded}`),
      { source }
    );
  }

  createMission(projectUUID: string, name: string) {
    return this.http.post(this.localApi(`/missions/${projectUUID}`), {
      name: name
    });
  }

  private normalizeDeviceProjects(response: Project[] | DeviceProjectListPayload): Project[] {
    if (Array.isArray(response)) {
      return response.map(project => this.normalizeDeviceProject(project));
    }
    return (response.projects ?? []).map(project => this.normalizeDeviceProject(project));
  }

  private normalizeDeviceProject(project: Project | DeviceProjectPayload): Project {
    const legacyId = 'id' in project ? project.id : undefined;
    return {
      name: project.name,
      uuid: project.uuid ?? legacyId ?? '',
      connection: project.connection,
    };
  }

  updateMissionOrder(projectUUID: string, missionName: string, position: number) {
    return this.http.put(this.localApi(`/missions/${projectUUID}/order`), {
      mission_name: missionName,
      order: position,
    });
  }

  getDetailedMission(projectUUID: string, name: string) {
    return this.http.get<Mission>(this.localApi(`/missions/${projectUUID}/detailed/${name}`));
  }

  deleteMission(projectUUID: string, name: string) {
    return this.http.delete(this.localApi(`/missions/${projectUUID}/mission/${name}`))
  }

  renameMission(projectUUID: string, oldName: string, newName: string) {
    return this.http.put(this.localApi(`/missions/${projectUUID}/rename`), {
      old_name: oldName,
      new_name: newName
    })
  }

  private toWebSocketUrl(httpUrl: string): string {
    // Convert an absolute HTTP(S) URL to WS(S). Assumes setIp normalized base.
    try {
      const u = new URL(httpUrl);
      if (u.protocol === 'http:') u.protocol = 'ws:';
      if (u.protocol === 'https:') u.protocol = 'wss:';
      return u.toString();
    } catch {
      // Best-effort fallback: if missing scheme, prepend http:// then convert
      try {
        const u = new URL(/^https?:\/\//i.test(httpUrl) ? httpUrl : `http://${httpUrl}`);
        if (u.protocol === 'http:') u.protocol = 'ws:';
        if (u.protocol === 'https:') u.protocol = 'wss:';
        if (!u.port) u.port = '8421';
        return u.toString();
      } catch {
        return httpUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
      }
    }
  }

  runMission(projectUUID: string, name: string | null, options?: RunMissionOptions): Observable<WebSocketResponse> {
    const params: string[] = [];
    const sim = options?.simulate ?? true;
    if (sim === 'real') {
      params.push('simulate=real');
    } else if (sim === 'fast' || sim === true) {
      params.push('simulate=fast');
    }
    if (options?.debug) {
      params.push('debug=1');
    }
    const query = params.length ? `?${params.join('&')}` : '';
    // No mission name -> hit the project-level /run endpoint (IntelliJ-style
    // whole-project run). With a name we keep using the per-mission route.
    const path = name
      ? `/missions/${projectUUID}/run/${encodeURIComponent(name)}${query}`
      : `/missions/${projectUUID}/run${query}`;
    const httpUrl = this.localApiAbsolute(path);
    const wsUrl = this.toWebSocketUrl(httpUrl);

    return new Observable<WebSocketResponse>((observer) => {
      let socket: WebSocket | null = null;
      try {
        socket = new WebSocket(wsUrl);
        options?.onSocket?.(socket);
      } catch (err) {
        observer.error(err);
        return undefined;
      }

      socket.onopen = () => {
        observer.next({ type: 'open', name: "open", index: 0 });
      };

      socket.onmessage = (ev: MessageEvent) => {
        const raw = ev.data;
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (parsed && typeof parsed === 'object') {
            const t = (parsed as { type?: unknown }).type;
            if (t === 'stdout' || t === 'stderr') {
              console.debug('[WS] message', t, (parsed as { line?: unknown }).line);
            }
          }
          observer.next(parsed);
        } catch {
          console.debug('[WS] non-JSON message', raw);
          observer.next(raw);
        }
      };

      socket.onerror = (event) => {
        observer.error(event);
      };

      socket.onclose = () => {
        observer.complete();
        options?.onSocket?.(null);
      };

      return () => {
        try {
          socket?.close(1000, 'Client unsubscribed');
        } catch {}
        options?.onSocket?.(null);
      };
    });
  }

  stopMission(projectUUID: string): Observable<any> {
    return this.http.post(this.localApi(`/missions/${projectUUID}/stop`), {});
  }

  saveMission(projectUUID: string, mission: Mission) {
    return this.http.put(this.localApi(`/missions/${projectUUID}/update`), mission);
  }

  // File editor API
  listProjectFiles(projectUuid: string): Observable<{ path: string; name: string }[]> {
    return this.http.get<{ path: string; name: string }[]>(this.localApi(`/files/${projectUuid}`));
  }

  getProjectFileContent(projectUuid: string, path: string): Observable<{ path: string; content: string }> {
    return this.http.get<{ path: string; content: string }>(
      this.localApi(`/files/${projectUuid}/content`),
      { params: { path } }
    );
  }

  updateProjectFileContent(projectUuid: string, path: string, content: string): Observable<{ success: boolean; path: string }> {
    return this.http.put<{ success: boolean; path: string }>(
      this.localApi(`/files/${projectUuid}/content`),
      { path, content }
    );
  }

  // Table Map API
  saveTableMap(mapData: TableMapFile) {
    return this.http.put<{ success: boolean }>(this.deviceApi('/api/v1/device/table-map'), mapData);
  }

  getTableMap() {
    return this.http.get<{ map: TableMapFile | null }>(this.deviceApi('/api/v1/device/table-map'));
  }
}
