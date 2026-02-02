import { Component, OnInit, OnDestroy } from '@angular/core';
import { InputGroup } from 'primeng/inputgroup';
import { InputText } from 'primeng/inputtext';
import { Button } from 'primeng/button';
import { FormsModule } from '@angular/forms';
import { Card } from 'primeng/card';
import { HttpService } from '../services/http-service';
import { ProgressSpinner } from 'primeng/progressspinner';
import { Router } from '@angular/router';
import { NotificationService } from '../services/NotificationService';
import { interval, Subscription, timeout } from 'rxjs';
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
  localProjectsCount = 0;
  localProjectsLoading = true;
  corsConfirmUrl?: string;
  corsConfirmSafeUrl?: SafeResourceUrl;
  corsConfirmIp?: string;
  private statusLoading = new Map<string, boolean>();
  private refreshSub?: Subscription;
  private readonly deviceInfoTimeoutMs = 4000;

  constructor(
    private httpService: HttpService,
    private router: Router,
    private translate: TranslateService,
    private sanitizer: DomSanitizer
  ) {
    const connections = localStorage.getItem("previousConnections");
    if (connections) {
      try {
        this.previousConnections = JSON.parse(connections) as ConnectionInfo[];
        // initialize battery fields to undefined (offline)
        this.previousConnections.forEach(conn => {
          conn.battery_voltage_v = undefined;
          conn.battery_percent = undefined;
          this.statusLoading.set(conn.ip, true);
        });
      } catch (e) {
        console.error('Error parsing previousConnections from localStorage', e);
        this.previousConnections = [];
      }
    }
  }

  ngOnInit() {
    this.httpService.clearDeviceBase();
    this.loadLocalProjects();
    this.updateDeviceInfos();

    this.refreshSub = interval(5000).subscribe(() => this.updateDeviceInfos());
  }

  ngOnDestroy() {
    this.refreshSub?.unsubscribe();
  }

  isStatusLoading(connection: ConnectionInfo): boolean {
    if (connection.battery_voltage_v != null || connection.battery_percent != null) {
      return false;
    }
    return this.statusLoading.get(connection.ip) === true;
  }

  private updateDeviceInfos() {
    for (const conn of this.previousConnections) {
      this.statusLoading.set(conn.ip, true);
      this.httpService.getDeviceInfo(conn.ip)
        .pipe(timeout(this.deviceInfoTimeoutMs))
        .subscribe({
          next: res => {
            conn.battery_voltage_v = res.battery_voltage_v;
            conn.battery_percent = res.battery_percent;
            conn.hostname = res.hostname;
            this.statusLoading.set(conn.ip, false);
            if (this.corsConfirmIp === conn.ip) {
              this.corsConfirmIp = undefined;
              this.corsConfirmUrl = undefined;
              this.corsConfirmSafeUrl = undefined;
            }
          },
          error: err => {
            conn.battery_voltage_v = undefined;
            conn.battery_percent = undefined;
            this.statusLoading.set(conn.ip, false);
            console.error(`Failed to fetch device info for ${conn.ip}`, err);
          }
        });
    }
  }

  private loadLocalProjects() {
    this.localProjectsLoading = true;
    this.httpService.getAllProjects().subscribe({
      next: projects => {
        this.localProjectsCount = projects.length;
        this.localProjectsLoading = false;
      },
      error: () => {
        this.localProjectsCount = 0;
        this.localProjectsLoading = false;
      }
    });
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
    this.statusLoading.set(targetIp, true);
    this.httpService.getDeviceInfo(targetIp)
      .pipe(timeout(this.deviceInfoTimeoutMs))
      .subscribe({
        next: (res) => {
          this.loading = false;
          const existing = this.previousConnections.find(c => c.ip === targetIp);
          res.ip = targetIp;

          if (existing) {
            existing.hostname = res.hostname;
            existing.battery_voltage_v = res.battery_voltage_v;
            existing.battery_percent = res.battery_percent;
          } else {
            this.previousConnections.push(res);
          }

          this.saveToLocalStorage();
          this.statusLoading.set(targetIp, false);
          this.httpService.setDeviceBase(targetIp);
          this.router.navigate(['/device', encodeRouteIp(targetIp), 'projects']);
          this.corsConfirmUrl = undefined;
          this.corsConfirmSafeUrl = undefined;
          this.corsConfirmIp = undefined;
        },
        error: (err) => {
          this.loading = false;
          this.statusLoading.set(targetIp, false);
          console.error(err);
          const existing = this.previousConnections.find(c => c.ip === targetIp);
          if (existing) {
            existing.battery_voltage_v = undefined;
            existing.battery_percent = undefined;
            existing.hostname = existing.hostname ?? '';
          } else {
            this.previousConnections.push({
              ip: targetIp,
              hostname: '',
              battery_voltage_v: undefined,
              battery_percent: undefined,
            });
          }
          this.saveToLocalStorage();
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

  openLocalProjects() {
    this.router.navigate(['/projects']);
  }

  saveToLocalStorage() {
    localStorage.setItem("previousConnections", JSON.stringify(this.previousConnections));
  }

  private isCorsLikeError(err: any): boolean {
    const message = (err?.message || err?.statusText || '').toString();
    const name = (err?.name || '').toString();

    // Exclude timeout errors
    if (/timeout/i.test(message) || /timeout/i.test(name)) {
      return false;
    }

    return err?.status === 0 || /CORS/i.test(message) || /TypeError/i.test(name);
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
      url.pathname = '/api/v1/device/confirm';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return `http://${ip}/api/v1/device/confirm`;
    }
  }
}
