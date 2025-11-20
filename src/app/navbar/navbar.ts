import { Component, computed, OnInit, signal, OnDestroy } from '@angular/core';
import { Button } from "primeng/button";
import { Select } from "primeng/select";
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import {ActivatedRoute, Router, NavigationEnd, RouterLink, RouterLinkActive} from '@angular/router';
import { filter, Subscription, interval, switchMap, takeUntil, Subject } from 'rxjs';
import { HttpService } from '../services/http-service';
import { enTranslations, deTranslations } from '../i18n/translations';
import { decodeRouteIp } from '../services/route-ip-serializer';

@Component({
  selector: 'app-navbar',
  imports: [
    Button,
    Select,
    FormsModule,
    RouterLink,
    RouterLinkActive,
    TranslateModule
  ],
  templateUrl: './navbar.html',
  styleUrl: './navbar.scss'
})
export class Navbar implements OnInit, OnDestroy {
  ip: string | null = null;
  isDarkMode = signal(false);
  deviceInfo: ConnectionInfo | undefined;

  iconClass = computed(() => this.isDarkMode() ? 'pi pi-sun' : 'pi pi-moon');

  languages = [
    { label: 'EN', value: 'en' },
    { label: 'DE', value: 'de' }
  ];
  selectedLanguage = 'en';

  private sub?: Subscription;
  private pollingSub?: Subscription;
  private destroy$ = new Subject<void>();

  constructor(
    private translate: TranslateService,
    private route: ActivatedRoute,
    private router: Router,
    private http: HttpService
  ) {
    translate.setTranslation('en', enTranslations, true);
    translate.setTranslation('de', deTranslations, true);
    translate.addLangs(['en', 'de']);
    translate.setDefaultLang('en');

    const savedLang = localStorage.getItem('selectedLanguage') || 'en';
    this.selectedLanguage = savedLang;
    translate.use(savedLang);

    const savedDarkMode = localStorage.getItem('selectedDarkMode') || 'light';
    if (savedDarkMode === 'dark') {
      this.toggleDarkMode();
    }
  }

  ngOnInit() {
    this.sub = this.router.events
      .pipe(filter(event => event instanceof NavigationEnd))
      .subscribe(() => {
        let route = this.route;
        while (route.firstChild) {
          route = route.firstChild;
        }

        const newIpRaw = route.snapshot.paramMap.get('ip');
        const newIp = decodeRouteIp(newIpRaw);

        if (newIp !== this.ip) {
          this.ip = newIp;
          if (newIp) {
            this.http.setIp(newIp);
          }
          this.deviceInfo = undefined;
          this.restartPolling();
        }
      });
  }

  private restartPolling() {
    this.pollingSub?.unsubscribe();
    this.pollingSub = undefined;

    if (this.ip) {
      this.pollingSub = interval(5000)
        .pipe(
          switchMap(() => this.http.getDeviceInfoDefault()),
          takeUntil(this.destroy$)
        )
        .subscribe({
          next: info => this.deviceInfo = info,
          error: err => console.error("Failed to fetch device info:", err)
        });

      //first polling
      this.http.getDeviceInfoDefault().subscribe({
        next: info => this.deviceInfo = info,
        error: err => console.error("Failed to fetch device info:", err)
      });
    }
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
    this.pollingSub?.unsubscribe();
    this.destroy$.next();
    this.destroy$.complete();
  }

  toggleDarkMode() {
    const element = document.querySelector('html');
    if (element) {
      const isDark = element.classList.toggle('dark');
      this.isDarkMode.set(isDark);
      localStorage.setItem("selectedDarkMode", this.isDarkMode() ? "dark" : "light");
    }
  }

  changeLanguage(lang: string) {
    this.translate.use(lang);
    localStorage.setItem('selectedLanguage', lang);
  }
}
