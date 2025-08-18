import { Component } from '@angular/core';
import {InputGroup} from 'primeng/inputgroup';
import {InputText} from 'primeng/inputtext';
import {Button} from 'primeng/button';
import {FormsModule} from '@angular/forms';
import {Card} from 'primeng/card';
import {HttpService} from '../services/http-service';
import {MessageService} from 'primeng/api';
import {ProgressSpinner} from 'primeng/progressspinner';
import {Router} from '@angular/router';

@Component({
  selector: 'app-home',
  imports: [
    InputGroup,
    InputText,
    Button,
    FormsModule,
    Card,
    ProgressSpinner,
  ],
  templateUrl: './home.html',
  styleUrl: './home.scss'
})
export class Home {
  ip: string = "";
  previousConnections: ConnectionInfo[] = [];
  loading: boolean = false;

  constructor(private httpService: HttpService, private messageService: MessageService, private router: Router) {
    const connections = localStorage.getItem("previousConnections");
    if (connections) {
      try {
        this.previousConnections = JSON.parse(connections) as ConnectionInfo[];

        for (const conn of this.previousConnections) {
          conn.battery_percent = 0;
          this.httpService.getDeviceInfo(conn.ip).subscribe(res => {
            conn.battery_percent = res.battery_percent;
            conn.hostname = res.hostname
          });
        }

      } catch (e) {
        console.error('Error parsing previousConnections from localStorage', e);
        this.previousConnections = [];
      }
    }
  }

  tryConnecting(ip: string) {
    this.loading = true;
    this.httpService.getDeviceInfo(ip).subscribe({
      next: (res) => {
        this.loading = false;
        const existing = this.previousConnections.find(c => c.ip === ip);
        res.ip = ip;

        if (existing) {
          existing.hostname = res.hostname;
          existing.battery_percent = res.battery_percent;
        } else {
          this.previousConnections.push(res);
        }

        this.saveToLocalStorage();
        this.router.navigate([ip + "/projects"]);
      },
      error: (err) => {
        this.loading = false;
        console.error(err);
        this.showError('Failed to connect to device');
      }
    });
  }

  removeConnection(ip: string) {
    this.previousConnections = this.previousConnections.filter(c => c.ip !== ip);
    this.saveToLocalStorage();
  }

  saveToLocalStorage() {
    localStorage.setItem("previousConnections", JSON.stringify(this.previousConnections));
  }

  showError(detail: string) {
    this.messageService.add({ severity: 'error', summary: 'Error', detail, life: 6000 });
  }
}
