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

@Component({
  selector: 'app-mission-panel',
  standalone: true,
  imports: [Card, PrimeTemplate, FormsModule, InputText, Button, Timeline, DragDropModule],
  templateUrl: './mission-panel.html',
  styleUrl: './mission-panel.scss'
})
export class MissionPanel implements OnInit {
  projectUUID: string | null = "";
  missions: Mission[] = [];
  missionTimelineData: any[] = [];
  addingMission = false;
  newMissionName = "";
  currentMission: Mission | undefined;

  constructor(private route: ActivatedRoute, private http: HttpService) {}

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
      }, error: error => {
        NotificationService.showError(error);
      }
    })
  }

  updateTimelineData() {
    this.missionTimelineData = this.missions
      .slice()
      .sort((a, b) => a.order - b.order)
      .map(mission => ({
        ...mission,
        type: 'mission'
      }));
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

  drop(event: CdkDragDrop<any[]>) {
    moveItemInArray(this.missionTimelineData, event.previousIndex, event.currentIndex);

    this.missionTimelineData.forEach((mission, idx) => {
      mission.order = idx + 1;
    });

    const updates = this.missionTimelineData.map(mission => {
      this.http.updateMission(this.projectUUID!, mission).toPromise()
    }
    );


    Promise.all(updates)
      .then(() => {
        NotificationService.showSuccess("Order updated");
      })
      .catch(err => {
        NotificationService.showError("Failed to update order");
        console.error(err);
      });
  }

}
