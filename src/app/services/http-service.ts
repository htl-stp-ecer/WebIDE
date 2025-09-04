import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class HttpService {
  private ipSubject = new BehaviorSubject<string>(''); // default empty
  ip$ = this.ipSubject.asObservable();

  constructor(private http: HttpClient) {}

  setIp(ip: string) {
    this.ipSubject.next(ip);
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

  getAllMissions() {
    return this.http.get(`${this.ip}/api/v1/missions`);
  }
}
