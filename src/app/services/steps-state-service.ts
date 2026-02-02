import {Injectable, signal} from '@angular/core';
import {Subject} from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class StepsStateService {
  currentSteps = signal<Step[] | null>(null);

  /** Emits when steps should be reloaded from the server */
  private refreshSubject = new Subject<void>();
  refresh$ = this.refreshSubject.asObservable();

  setSteps(steps: Step[]) {
    this.currentSteps.set(steps);
  }

  /** Trigger a refresh of steps from the server */
  triggerRefresh() {
    this.refreshSubject.next();
  }
}
