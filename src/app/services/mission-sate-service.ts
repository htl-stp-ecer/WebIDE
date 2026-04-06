import { Injectable, signal } from '@angular/core';
import { Mission } from '../entities/Mission';

@Injectable({ providedIn: 'root' })
export class MissionStateService {
  currentMission = signal<Mission | null>(null);
  allMissions = signal<Mission[]>([]);

  setMission(mission: Mission | null) {
    this.currentMission.set(mission);
  }

  setAllMissions(missions: Mission[]) {
    this.allMissions.set(missions);
  }
}
