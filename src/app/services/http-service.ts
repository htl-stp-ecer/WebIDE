import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject } from 'rxjs';
import {Mission} from '../entities/Mission';

@Injectable({
  providedIn: 'root'
})
export class HttpService {
  private ipSubject = new BehaviorSubject<string>('');
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
    return this.http.delete(`${this.ip}/api/v1/missions/${projectUUID}/${name}`)
  }

  renameMission(projectUUID: string, oldName: string, newName: string) {
    return this.http.put(`${this.ip}/api/v1/missions/${projectUUID}/rename`, {
      old_name: oldName,
      new_name: newName
    })
  }
}
