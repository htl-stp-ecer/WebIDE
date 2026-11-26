import {Component, signal, ChangeDetectionStrategy} from '@angular/core';
import {Router, RouterOutlet} from '@angular/router';
import {FormsModule} from '@angular/forms';
import {Navbar} from './navbar/navbar';
import {Toast} from '@openng/optimus-ui/toast';
import {NotificationService} from './services/NotificationService';
import {NgClass} from '@angular/common';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    FormsModule,
    Navbar,
    Toast,
    NgClass,
  ],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './app.scss'
})
export class App {
  protected readonly title = signal('WebIDE');

  constructor(private notificationService: NotificationService, protected router: Router) {
  }

}
