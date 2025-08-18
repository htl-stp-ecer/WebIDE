import {Component, signal} from '@angular/core';
import {RouterOutlet} from '@angular/router';
import {FormsModule} from '@angular/forms';
import {Navbar} from './navbar/navbar';
import {Toast} from 'primeng/toast';
import {NotificationService} from './services/NotificationService';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    FormsModule,
    Navbar,
    Toast,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected readonly title = signal('WebIDE');

  constructor(private notificationService: NotificationService) {
  }

}
