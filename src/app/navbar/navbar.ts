import { Component, OnInit, OnDestroy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { Subscription, interval, switchMap, takeUntil, Subject } from 'rxjs';
import { HttpService } from '../services/http-service';
import { enTranslations, deTranslations } from '../i18n/translations';

@Component({
  selector: 'app-navbar',
  imports: [
    FormsModule,
    RouterLink,
    RouterLinkActive,
    TranslateModule,
    DecimalPipe,
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
    private http: HttpService
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
}
