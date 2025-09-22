import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HttpService } from '../../services/http-service';
import { Mission } from '../../entities/Mission';
import { NotificationService } from '../../services/NotificationService';
import { Card } from 'primeng/card';
import { PrimeTemplate } from 'primeng/api';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { Button } from 'primeng/button';
import { Timeline } from 'primeng/timeline';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import {NgClass} from '@angular/common';
import {MissionStateService} from '../../services/mission-sate-service';

@Component({
  selector: 'app-mission-panel',
  standalone: true,
  imports: [Card, PrimeTemplate, FormsModule, InputText, Button, Timeline, DragDropModule, NgClass],
  templateUrl: './mission-panel.html',
  styleUrl: './mission-panel.scss'
})
export class MissionPanel implements OnInit {
  projectUUID: string | null = "";
  missions: Mission[] = [];
  missionTimelineData: any[] = [];
  topMissions: any[] = [];
  middleMissions: any[] = [];
  bottomMissions: any[] = [];
  addingMission = false;
  newMissionName = "";
  currentMission: Mission | undefined;

  constructor(private route: ActivatedRoute, private http: HttpService, private missionState: MissionStateService) {}

  ngOnInit(): void {
    this.projectUUID = this.route.snapshot.paramMap.get('uuid');
    this.getMissions();
  }

  getMissions(): void {
    this.http.getAllMissions(this.projectUUID!).subscribe({
      next: result => {
        this.missions = result;
        this.updateTimelineData();
        this.getDetailedMission(result[0].name)
      },
      error: error => {
        NotificationService.showError("Could not get missions");
        console.log(error);
      }
    });
  }

  getDetailedMission(name: string) {
    this.http.getDetailedMission(this.projectUUID!, name).subscribe({
      next: result => {
        this.currentMission = result;
        this.missionState.setMission(result)
      }, error: error => {
        NotificationService.showError(error);
      }
    })
  }

  updateTimelineData() {
    const ordered = this.missions
      .slice()
      .sort(this.missionComparator)
      .map(mission => ({
        ...mission,
        type: 'mission'
      }));

    // Partition into fixed-top (setups + both), reorderable middle, fixed-bottom (shutdown-only)
    this.topMissions = ordered.filter(m => m.is_setup);
    this.bottomMissions = ordered.filter(m => m.is_shutdown && !m.is_setup);
    this.middleMissions = ordered.filter(m => !m.is_setup && !m.is_shutdown);

    // Retain a combined view if needed elsewhere
    this.missionTimelineData = [...this.topMissions, ...this.middleMissions, ...this.bottomMissions];
  }

  enableAddMission() {
    this.addingMission = true;
    this.newMissionName = "";
  }

  cancelAddMission() {
    this.addingMission = false;
  }

  createMission() {
    if (!this.newMissionName.trim()) {
      NotificationService.showError("Mission name cannot be empty");
      return;
    }
    this.http.createMission(this.projectUUID!, this.newMissionName).subscribe({
      next: (res) => {
        NotificationService.showSuccess("Mission created successfully.");
        this.getMissions();
        this.addingMission = false;
      },
      error: err => {
        NotificationService.showError("Could not create mission");
        console.error(err);
      }
    });
  }

  dropMiddle(event: CdkDragDrop<any[]>) {
    // Snapshot previous orders for middle missions by name
    const prevOrderByName = new Map<string, number | undefined>(
      this.middleMissions.map(m => [m.name, m.order])
    );

    // Reorder only within the middle list (non-setup, non-shutdown)
    moveItemInArray(this.middleMissions, event.previousIndex, event.currentIndex);

    // Keep the exact set of order values that middle missions already had
    const middleOrderValues = this.middleMissions
      .map(m => m.order ?? 0)
      .sort((a, b) => a - b);

    // Assign those order values to the new sequence
    const updatedMiddle = this.middleMissions.map((mission, idx) => ({
      ...mission,
      order: middleOrderValues[idx]
    }));

    // Only update missions whose order actually changed
    const toUpdate = updatedMiddle.filter(m => prevOrderByName.get(m.name) !== m.order);

    Promise.all(toUpdate.map(m => {
      if (!m.is_setup && !m.is_shutdown)
      this.http.updateMissionOrder(this.projectUUID!, m).toPromise()
    }))
      .then(() => {
        // Apply updates locally after success without touching setup/shutdown
        this.middleMissions = updatedMiddle;
        this.missionTimelineData = [...this.topMissions, ...this.middleMissions, ...this.bottomMissions];
        NotificationService.showSuccess("Order updated");
      })
      .catch(err => {
        NotificationService.showError("Failed to update order");
        console.error(err);
      });
  }

  private missionComparator = (a: Mission, b: Mission): number => {
    if (a.is_setup !== b.is_setup) return a.is_setup ? -1 : 1;  // setups first
    if (a.is_shutdown !== b.is_shutdown) return a.is_shutdown ? 1 : -1; // shutdowns last
    return (a.order ?? 0) - (b.order ?? 0);
  };

}
