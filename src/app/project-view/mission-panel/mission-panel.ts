import {Component, OnInit} from '@angular/core';
import {ActivatedRoute} from '@angular/router';
import {HttpService} from '../../services/http-service';
import {Mission} from '../../entities/Mission';
import {NotificationService} from '../../services/NotificationService';
import {Card} from 'primeng/card';
import {PrimeTemplate} from 'primeng/api';
import {FormsModule} from '@angular/forms';
import {InputText} from 'primeng/inputtext';
import {Button} from 'primeng/button';
import {Timeline} from 'primeng/timeline';

@Component({
  selector: 'app-mission-panel',
  standalone: true,
  imports: [Card, PrimeTemplate, FormsModule, InputText, Button, Timeline],
  templateUrl: './mission-panel.html',
  styleUrl: './mission-panel.scss'
})
export class MissionPanel implements OnInit {
  projectUUID: string | null = "";
  missions: Mission[] = []
  missionTimelineData: any[] = []; // Renamed for clarity - only missions

  addingMission = false;
  newMissionName = "";

  constructor(private route: ActivatedRoute, private http: HttpService) {}

  ngOnInit(): void {
    this.projectUUID = this.route.snapshot.paramMap.get('uuid');
    this.getMissions()
  }

  getMissions(): void {
    this.http.getAllMissions(this.projectUUID!).subscribe({
      next: result => {
        this.missions = result;
        this.updateTimelineData();
      },
      error: error => {
        NotificationService.showError("Could not get missions");
        console.log(error);
      }
    });
  }

  updateTimelineData() {
    this.missionTimelineData = this.missions
      .slice() // copy so original stays intact
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
        this.getMissions()
        this.addingMission = false;
      },
      error: err => {
        NotificationService.showError("Could not create mission");
        console.error(err);
      }
    });
  }
}
