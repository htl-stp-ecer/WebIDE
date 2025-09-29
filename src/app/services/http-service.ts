import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable } from 'rxjs';
import {Mission} from '../entities/Mission';

@Injectable({
  providedIn: 'root'
})
export class HttpService {
  private ipSubject = new BehaviorSubject<string>('');
  ip$ = this.ipSubject.asObservable();

  constructor(private http: HttpClient) {}

  setIp(ip: string) {
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
        u.port = '8000';
      }
      // Keep only origin (scheme://host:port)
      this.ipSubject.next(u.origin);
    } catch {
      // Fallback to previous behavior if parsing fails
      this.ipSubject.next(base);
    }
  }

  private get ip() {
    const ip = this.ipSubject.getValue();
    if (!ip) throw new Error('IP not set!');
    return ip;
  }

  getDeviceInfo(ip: string) {
    return this.http.get<ConnectionInfo>(`${ip}/api/v1/device/info`);
  }

  getDeviceInfoDefault() {
    return this.getDeviceInfo(this.ip);
  }

  changeHostname(newName: string) {
    return this.http.put<any>(`${this.ip}/api/v1/device/hostname`, { hostname: newName });
  }

  getAllProjects() {
    return this.http.get<Project[]>(`${this.ip}/api/v1/projects`);
  }

  deleteProject(uuid: string) {
    return this.http.delete(`${this.ip}/api/v1/projects/${uuid}`);
  }

  createProject(newProject: string) {
    return this.http.post<Project>(`${this.ip}/api/v1/projects`, { name: newProject });
  }

  getAllSteps() {
    return this.http.get<Step[]>(`${this.ip}/api/v1/steps`);
  }

  getAllMissions(projectUUID: string) {
    return this.http.get<Mission[]>(`${this.ip}/api/v1/missions/${projectUUID}`);
  }

  createMission(projectUUID: string, name: string) {
    return this.http.post(`${this.ip}/api/v1/missions/${projectUUID}`, {
      name: name
    });
  }

  updateMissionOrder(projectUUID: string, mission: Mission) {
    return this.http.put(`${this.ip}/api/v1/missions/${projectUUID}/order`, {
      mission_name: mission.name,
      order: mission.order,
    });
  }

  getDetailedMission(projectUUID: string, name: string) {
    return this.http.get<Mission>(`${this.ip}/api/v1/missions/${projectUUID}/detailed/${name}`);
  }

  deleteMission(projectUUID: string, name: string) {
    return this.http.delete(`${this.ip}/api/v1/missions/${projectUUID}/mission/${name}`)
  }

  renameMission(projectUUID: string, oldName: string, newName: string) {
    return this.http.put(`${this.ip}/api/v1/missions/${projectUUID}/rename`, {
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
        if (!u.port) u.port = '8000';
        return u.toString();
      } catch {
        return httpUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
      }
    }
  }

  runMission(projectUUID: string, name: string): Observable<any> {
    const httpUrl = `${this.ip}/api/v1/missions/${projectUUID}/run/${name}?simulate=1`;
    const wsUrl = this.toWebSocketUrl(httpUrl);

    return new Observable<any>((observer) => {
      let socket: WebSocket | null = null;
      try {
        socket = new WebSocket(wsUrl);
      } catch (err) {
        observer.error(err);
        return undefined;
      }

      socket.onopen = () => {
        observer.next({ type: 'open' });
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
      };

      return () => {
        try {
          socket?.close(1000, 'Client unsubscribed');
        } catch {}
      };
    });
  }
}
