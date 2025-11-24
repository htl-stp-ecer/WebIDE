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
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

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
  corsConfirmUrl?: string;
  corsConfirmSafeUrl?: SafeResourceUrl;
  corsConfirmIp?: string;
  private refreshSub?: Subscription;

  constructor(
    private httpService: HttpService,
    private messageService: MessageService,
    private router: Router,
    private translate: TranslateService,
    private sanitizer: DomSanitizer
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
          if (this.corsConfirmIp === conn.ip) {
            this.corsConfirmIp = undefined;
            this.corsConfirmUrl = undefined;
            this.corsConfirmSafeUrl = undefined;
          }
        },
        error: err => {
          conn.battery_percent = 0
          console.error(`Failed to fetch device info for ${conn.ip}`, err);
        }
      });
    }
  }

  tryConnecting(ip: string) {
    this.corsConfirmUrl = undefined;
    this.corsConfirmSafeUrl = undefined;
    this.corsConfirmIp = undefined;
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
        this.corsConfirmUrl = undefined;
        this.corsConfirmSafeUrl = undefined;
        this.corsConfirmIp = undefined;
      },
      error: (err) => {
        this.loading = false;
        console.error(err);
        NotificationService.showError(
          this.translate.instant('HOME.CONNECT_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
        if (this.isCorsLikeError(err)) {
          this.corsConfirmIp = targetIp;
          this.corsConfirmUrl = this.buildConfirmUrl(targetIp);
          this.corsConfirmSafeUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.corsConfirmUrl);
        }
      }
    });
  }

  removeConnection(ip: string) {
    this.previousConnections = this.previousConnections.filter(c => c.ip !== ip);
    if (this.corsConfirmIp === ip) {
      this.corsConfirmIp = undefined;
      this.corsConfirmUrl = undefined;
      this.corsConfirmSafeUrl = undefined;
    }
    this.saveToLocalStorage();
  }

  saveToLocalStorage() {
    localStorage.setItem("previousConnections", JSON.stringify(this.previousConnections));
  }

  private isCorsLikeError(err: any): boolean {
    const message = (err?.message || err?.statusText || '').toString();
    return err?.status === 0 || /CORS/i.test(message) || /TypeError/i.test(err?.name);
  }

  private buildConfirmUrl(ip: string): string {
    let base = (ip || '').trim();
    if (!/^https?:\/\//i.test(base)) {
      base = 'http://' + base;
    }
    try {
      const url = new URL(base);
      if (!url.port) {
        url.port = '8000';
      }
      url.pathname = '/api/v1/confirm';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return `http://${ip}/api/v1/confirm`;
    }
  }
}
