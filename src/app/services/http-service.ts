import { Injectable } from '@angular/core';
import {HttpClient} from '@angular/common/http';

@Injectable({
  providedIn: 'root'
})
export class HttpService {
  constructor(private http: HttpClient) {}

  getDeviceInfo(ip: string) {
    return this.http.get<ConnectionInfo>(`${ip}/api/v1/device/info`)
  }

  changeHostname(ip: string, newName: string) {
    return this.http.put<any>(`${ip}/api/v1/device/hostname`, {hostname: newName})
  }

  getAllProjects(ip: string) {
    return this.http.get<Project[]>(`${ip}/api/v1/projects`)
  }

  deleteProject(ip: string, uuid: string) {
    return this.http.delete(`${ip}/api/v1/projects/${uuid}`)
  }

  createProject(ip: string, newProject: string) {
    return this.http.post<Project>(`${ip}/api/v1/projects`, {name: newProject})
  }

  getAllSteps(ip: string) {
    return this.http.get<Step[]>(`${ip}/api/v1/steps`)
  }
}
