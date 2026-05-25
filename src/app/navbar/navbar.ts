import { Component, OnInit, OnDestroy, HostListener, ViewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { Subscription, interval, switchMap, takeUntil, Subject } from 'rxjs';
import { HttpService, RunConfiguration } from '../services/http-service';
import { RunActionService, RunTarget } from '../services/run-action-service';
import { enTranslations, deTranslations } from '../i18n/translations';
import { RunConfigurationsDialog } from '../run-configurations-dialog/run-configurations-dialog';

@Component({
  selector: 'app-navbar',
  imports: [
    FormsModule,
    RouterLink,
    RouterLinkActive,
    TranslateModule,
    DecimalPipe,
    RunConfigurationsDialog,
  ],
  templateUrl: './navbar.html',
  styleUrl: './navbar.scss'
})
export class Navbar implements OnInit, OnDestroy {
  deviceBase: string | null = null;
  deviceInfo: ConnectionInfo | undefined;
  deviceInfoLoading = false;

  languages = [
    { label: 'EN', value: 'en' },
    { label: 'DE', value: 'de' }
  ];
  selectedLanguage = 'en';

  private deviceBaseSub?: Subscription;
  private pollingSub?: Subscription;
  private destroy$ = new Subject<void>();

  constructor(
    private translate: TranslateService,
    private http: HttpService,
    readonly runAction: RunActionService
  ) {
    translate.setTranslation('en', enTranslations, true);
    translate.setTranslation('de', deTranslations, true);
    translate.addLangs(['en', 'de']);
    translate.setDefaultLang('en');

    const savedLang = localStorage.getItem('selectedLanguage') || 'en';
    this.selectedLanguage = savedLang;
    translate.use(savedLang);
  }

  ngOnInit() {
    this.deviceBaseSub = this.http.deviceBase$.subscribe(base => {
      const nextBase = base || null;
      if (nextBase !== this.deviceBase) {
        this.deviceBase = nextBase;
        this.deviceInfo = undefined;
        this.deviceInfoLoading = !!this.deviceBase;
        this.restartPolling();
      }
    });
  }

  private restartPolling() {
    this.pollingSub?.unsubscribe();
    this.pollingSub = undefined;

    if (this.deviceBase) {
      if (!this.deviceInfo) {
        this.deviceInfoLoading = true;
      }
      this.pollingSub = interval(5000)
        .pipe(
          switchMap(() => this.http.getDeviceInfoDefault()),
          takeUntil(this.destroy$)
        )
        .subscribe({
          next: info => {
            this.deviceInfo = info;
            this.deviceInfoLoading = false;
          },
          error: err => {
            this.deviceInfoLoading = false;
            console.error("Failed to fetch device info:", err);
          }
        });

      if (!this.deviceInfo) {
        this.deviceInfoLoading = true;
      }
      this.http.getDeviceInfoDefault().subscribe({
        next: info => {
          this.deviceInfo = info;
          this.deviceInfoLoading = false;
        },
        error: err => {
          this.deviceInfoLoading = false;
          console.error("Failed to fetch device info:", err);
        }
      });
    }
  }

  ngOnDestroy() {
    this.deviceBaseSub?.unsubscribe();
    this.pollingSub?.unsubscribe();
    this.destroy$.next();
    this.destroy$.complete();
  }

  changeLanguage(lang: string) {
    this.translate.use(lang);
    localStorage.setItem('selectedLanguage', lang);
  }

  runTargetMenuOpen = false;

  toggleRunTargetMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.runTargetMenuOpen = !this.runTargetMenuOpen;
  }

  @ViewChild(RunConfigurationsDialog) private configsDialog?: RunConfigurationsDialog;

  selectRunTarget(target: RunTarget): void {
    this.runAction.setRunTarget(target);
    this.runTargetMenuOpen = false;
  }

  selectRunConfig(name: string): void {
    this.runAction.selectRunConfig(name);
    this.runTargetMenuOpen = false;
  }

  openEditConfigurations(): void {
    this.runTargetMenuOpen = false;
    this.configsDialog?.show();
  }

  iconForConfig(cfg: RunConfiguration | null): string {
    if (!cfg) return 'pi pi-question';
    if (cfg.target === 'simulated') return 'pi pi-objects-column';
    if (cfg.dev) return 'pi pi-wrench';
    if (cfg.no_calibrate || cfg.no_checkpoints) return 'pi pi-forward';
    return 'pi pi-bolt';
  }

  configSummary(cfg: RunConfiguration): string {
    const flags: string[] = [];
    if (cfg.dev) flags.push('--dev');
    if (cfg.no_calibrate) flags.push('--no-calibrate');
    if (cfg.no_checkpoints) flags.push('--no-checkpoints');
    if (cfg.no_codegen) flags.push('--no-codegen');
    if (cfg.no_sync) flags.push('--no-sync');
    if (cfg.record_localization) flags.push('--record-localization');
    return flags.length ? flags.join(' ') : 'raccoon run';
  }

  runConfigTooltip(): string {
    const cfg = this.runAction.selectedRunConfig();
    if (!cfg) return 'Select a run configuration';
    return cfg.description || this.configSummary(cfg);
  }

  runTargetTooltip(): string {
    return this.runAction.runTarget() === 'simulated'
      ? 'Run all missions in the libstp simulator'
      : 'Run on the wombat (raccoon run)';
  }

  @HostListener('document:click')
  closeRunTargetMenuOnOutsideClick(): void {
    if (this.runTargetMenuOpen) {
      this.runTargetMenuOpen = false;
    }
  }
}
