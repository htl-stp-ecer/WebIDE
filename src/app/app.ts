import {Component, computed, signal} from '@angular/core';
import {RouterOutlet} from '@angular/router';
import {Button} from 'primeng/button';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    Button
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected readonly title = signal('WebIDE');

  isDarkMode = signal(false);

  iconClass = computed(() => this.isDarkMode() ? 'pi pi-sun' : 'pi pi-moon');

  toggleDarkMode() {
    const element = document.querySelector('html');
    if (element) {
      const isDark = element.classList.toggle('dark-theme');
      this.isDarkMode.set(isDark);
    }
  }
}
