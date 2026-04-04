import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, map, Observable } from 'rxjs';
import {Mission} from '../entities/Mission';
import { TypeDefinition } from '../entities/TypeDefinition';
import { MissionSimulationData, ProjectSimulationData } from '../entities/Simulation';

export interface TableMapFileV1 {
  format: 'flowchart-table-map';
  version: 1;
  table: { widthCm: number; heightCm: number };
  lines: Array<{
    kind: 'line' | 'wall';
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    widthCm: number;
  }>;
}

interface RunMissionOptions {
  simulate?: boolean;
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
    // Normalize incoming IP/base so both HttpClient and WebSocket use the same origin
    // - Ensure scheme
    // - Default to port 8000 if none provided (to match PortInterceptor behavior)
    let base = (ip || '').trim();
    try {
      if (!/^https?:\/\//i.test(base)) {
        base = 'http://' + base;
      }
      const u = new URL(base);
      if (!u.port) {
        u.port = '8421';
      }
      // Keep only origin (scheme://host:port)
      this.deviceBaseSubject.next(u.origin);
    } catch {
      // Fallback to previous behavior if parsing fails
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
    return this.http.get<{ map: TableMapFileV1 | null }>(this.localApi(`/device/${projectUuid}/table-map`));
  }

  saveLocalTableMap(projectUuid: string, mapData: TableMapFileV1) {
    return this.http.put<{ success: boolean }>(this.localApi(`/device/${projectUuid}/table-map`), mapData);
  }

  getAllProjects() {
    return this.http.get<Project[]>(this.localApi('/projects'));
  }

  getProject(uuid: string) {
    return this.http.get<Project>(this.localApi(`/projects/${uuid}`));
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

  getDeviceSteps() {
    return this.http.get<Step[]>(this.deviceApi('/api/v1/steps'));
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
    const params = new URLSearchParams();
    if (this.deviceBase) {
      params.set('device_url', this.deviceBase);
    }
    if (forceClear) {
      params.set('force_clear', '1');
    }
    const query = params.toString();
    return this.http.post<{ status: string; count?: number; last_indexed_at?: string; error?: string }>(
      this.localApi(query ? `/steps/index/refresh?${query}` : '/steps/index/refresh'),
      {}
    );
  }

  clearStepIndex() {
    return this.http.post<{ status: string; count?: number; last_indexed_at?: string; error?: string }>(
      this.localApi('/steps/index/clear'),
      {}
    );
  }

  importStepIndex(steps: Step[]) {
    return this.http.post<{ status: string; count?: number; last_indexed_at?: string; error?: string }>(
      this.localApi('/steps/index/import'),
      { steps }
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

  updateMissionOrder(projectUUID: string, mission: Mission) {
    return this.http.put(this.localApi(`/missions/${projectUUID}/order`), {
      mission_name: mission.name,
      order: mission.order,
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

  runMission(projectUUID: string, name: string, options?: RunMissionOptions): Observable<WebSocketResponse> {
    const params: string[] = [];
    const shouldSimulate = options?.simulate ?? true;
    if (shouldSimulate) {
      params.push('simulate=1');
    }
    if (options?.debug) {
      params.push('debug=1');
    }
    const query = params.length ? `?${params.join('&')}` : '';
    const httpUrl = this.localApiAbsolute(`/missions/${projectUUID}/run/${name}${query}`);
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
          observer.next(parsed);
        } catch {
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
  saveTableMap(mapData: TableMapFileV1) {
    return this.http.put<{ success: boolean }>(this.deviceApi('/api/v1/device/table-map'), mapData);
  }

  getTableMap() {
    return this.http.get<{ map: TableMapFileV1 | null }>(this.deviceApi('/api/v1/device/table-map'));
  }
}
