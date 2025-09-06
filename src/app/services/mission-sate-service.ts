import { Injectable, signal } from '@angular/core';
import { Mission } from '../entities/Mission';

@Injectable({ providedIn: 'root' })
export class MissionStateService {
  currentMission = signal<Mission | null>(null);

  setMission(mission: Mission) {
    this.currentMission.set(mission);
  }
}
