import {Injectable, signal} from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class StepsStateService {
  currentSteps = signal<Step[] | null>(null);

  setSteps(step: Step[]) {
    this.currentSteps.set(step);
  }
}
