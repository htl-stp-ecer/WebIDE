import { Component, OnInit, OnDestroy } from '@angular/core';
import { InputGroup } from 'primeng/inputgroup';
import { InputText } from 'primeng/inputtext';
import { Button } from 'primeng/button';
import { FormsModule } from '@angular/forms';
import { Card } from 'primeng/card';
import { HttpService } from '../services/http-service';
import { MessageService } from 'primeng/api';
import { ProgressSpinner } from 'primeng/progressspinner';
import { Router } from '@angular/router';
import { NotificationService } from '../services/NotificationService';
import { interval, Subscription } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { encodeRouteIp } from '../services/route-ip-serializer';

@Component({
  selector: 'app-home',
  imports: [
    InputGroup,
    InputText,
    Button,
    FormsModule,
    Card,
    ProgressSpinner,
    TranslateModule,
  ],
  templateUrl: './home.html',
  styleUrl: './home.scss'
})
export class Home implements OnInit, OnDestroy {
  ip: string = "";
  previousConnections: ConnectionInfo[] = [];
  loading: boolean = false;
  private refreshSub?: Subscription;

  constructor(
    private httpService: HttpService,
    private messageService: MessageService,
    private router: Router,
    private translate: TranslateService
  ) {
    const connections = localStorage.getItem("previousConnections");
    if (connections) {
      try {
        this.previousConnections = JSON.parse(connections) as ConnectionInfo[];
        // initialize battery_percent to 0
        this.previousConnections.forEach(conn => conn.battery_percent = 0);
      } catch (e) {
        console.error('Error parsing previousConnections from localStorage', e);
        this.previousConnections = [];
      }
    }
  }

  ngOnInit() {
    this.updateDeviceInfos();

    this.refreshSub = interval(5000).subscribe(() => this.updateDeviceInfos());
  }

  ngOnDestroy() {
    this.refreshSub?.unsubscribe();
  }

  private updateDeviceInfos() {
    for (const conn of this.previousConnections) {
      this.httpService.getDeviceInfo(conn.ip).subscribe({
        next: res => {
          conn.battery_percent = res.battery_percent;
          conn.hostname = res.hostname;
        },
        error: err => {
          conn.battery_percent = 0
          console.error(`Failed to fetch device info for ${conn.ip}`, err);
        }
      });
    }
  }

  tryConnecting(ip: string) {
    const targetIp = (ip || '').trim();
    if (!targetIp) {
      return;
    }

    this.loading = true;
    this.httpService.getDeviceInfo(targetIp).subscribe({
      next: (res) => {
        this.loading = false;
        const existing = this.previousConnections.find(c => c.ip === targetIp);
        res.ip = targetIp;

        if (existing) {
          existing.hostname = res.hostname;
          existing.battery_percent = res.battery_percent;
        } else {
          this.previousConnections.push(res);
        }

        this.saveToLocalStorage();
        this.router.navigate(['/', encodeRouteIp(targetIp), 'projects']);
      },
      error: (err) => {
        this.loading = false;
        console.error(err);
        NotificationService.showError(
          this.translate.instant('HOME.CONNECT_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
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
}
