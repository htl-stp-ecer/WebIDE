import {Component, signal} from '@angular/core';
import {RouterOutlet} from '@angular/router';
import {FormsModule} from '@angular/forms';
import {Navbar} from './navbar/navbar';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    FormsModule,
    Navbar
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected readonly title = signal('WebIDE');

}
