import {Component, computed, signal} from '@angular/core';
import {Button} from "primeng/button";
import {Select} from "primeng/select";
import {TranslateService} from '@ngx-translate/core';
import {FormsModule} from '@angular/forms';

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
export class Navbar {

  isDarkMode = signal(false);

  iconClass = computed(() => this.isDarkMode() ? 'pi pi-sun' : 'pi pi-moon');

  // Language Switcher
  languages = [
    { label: 'EN', value: 'en' },
    { label: 'DE', value: 'de' }
  ];
  selectedLanguage = 'en';

  constructor(private translate: TranslateService) {
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
