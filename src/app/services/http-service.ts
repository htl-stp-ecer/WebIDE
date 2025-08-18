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
}
