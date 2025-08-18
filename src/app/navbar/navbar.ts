import { Component, computed, OnInit, signal, OnDestroy } from '@angular/core';
import { Button } from "primeng/button";
import { Select } from "primeng/select";
import { TranslateService } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, NavigationEnd } from '@angular/router';
import { filter, Subscription, interval, switchMap, takeUntil, Subject } from 'rxjs';
import { HttpService } from '../services/http-service';

@Component({
  selector: 'app-navbar',
  imports: [
    Button,
    Select,
    FormsModule
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

        const newIp = route.snapshot.paramMap.get('ip');

        if (newIp !== this.ip) {
          this.ip = newIp;
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
          switchMap(() => this.http.getDeviceInfo(this.ip!)),
          takeUntil(this.destroy$)
        )
        .subscribe({
          next: info => this.deviceInfo = info,
          error: err => console.error("Failed to fetch device info:", err)
        });

      //first polling
      this.http.getDeviceInfo(this.ip).subscribe({
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
      const isDark = element.classList.toggle('dark-theme');
      this.isDarkMode.set(isDark);
      localStorage.setItem("selectedDarkMode", this.isDarkMode() ? "dark" : "light");
    }
  }

  changeLanguage(lang: string) {
    this.translate.use(lang);
    localStorage.setItem('selectedLanguage', lang);
  }
}
