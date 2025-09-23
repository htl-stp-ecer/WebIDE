import { Component, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpService } from '../../services/http-service';
import { Mission } from '../../entities/Mission';
import { NotificationService } from '../../services/NotificationService';
import { Card } from 'primeng/card';
import { PrimeTemplate } from 'primeng/api';
import type { MenuItem } from 'primeng/api';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { Button } from 'primeng/button';
import { Timeline } from 'primeng/timeline';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import {NgClass} from '@angular/common';
import {MissionStateService} from '../../services/mission-sate-service';
import { ContextMenu } from 'primeng/contextmenu';

@Component({
  selector: 'app-mission-panel',
  standalone: true,
  imports: [Card, PrimeTemplate, FormsModule, InputText, Button, Timeline, DragDropModule, NgClass, ContextMenu],
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
  contextMenuItems: MenuItem[] = [];
  private contextMission?: Mission;

  @ViewChild('missionMenu') missionMenu?: ContextMenu;

  constructor(private route: ActivatedRoute, private http: HttpService, private missionState: MissionStateService, private router: Router) {}

  ngOnInit(): void {
    this.projectUUID = this.route.snapshot.paramMap.get('uuid');
    this.getMissions();
  }

  backToProjects() {

    this.router.navigate([this.router.url.split("projects/")[0], 'projects']);
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

  onRightClickMission(event: MouseEvent, mission: Mission) {
    event.preventDefault();
    this.contextMission = mission;
    this.contextMenuItems = [
      {
        label: 'Rename',
        icon: 'pi pi-pencil',
        command: () => this.renameMissionPrompt()
      },
      {
        label: 'Delete',
        icon: 'pi pi-trash',
        command: () => this.deleteMissionConfirm()
      }
    ];
    this.missionMenu?.show(event);
  }

  private renameMissionPrompt() {
    if (!this.contextMission || !this.projectUUID) return;
    const oldName = this.contextMission.name;
    const newName = window.prompt('Rename mission', oldName)?.trim();
    if (newName == null) return; // cancelled
    if (!newName) {
      NotificationService.showError('Mission name cannot be empty');
      return;
    }
    if (newName === oldName) return;
    if (this.missions.some(m => m.name === newName)) {
      NotificationService.showError('A mission with that name already exists');
      return;
    }
    this.http.renameMission(this.projectUUID, oldName, newName).subscribe({
      next: () => {
        NotificationService.showSuccess('Mission renamed');
        // update current selection if needed
        if (this.currentMission?.name === oldName) {
          this.currentMission = { ...this.currentMission, name: newName } as Mission;
          this.missionState.setMission(this.currentMission);
        }
        this.getMissions();
      },
      error: err => {
        NotificationService.showError('Failed to rename mission');
        console.error(err);
      }
    });
  }

  private deleteMissionConfirm() {
    if (!this.contextMission || !this.projectUUID) return;
    const name = this.contextMission.name;
    const confirmed = window.confirm(`Delete mission "${name}"? This cannot be undone.`);
    if (!confirmed) return;
    this.http.deleteMission(this.projectUUID, name).subscribe({
      next: () => {
        NotificationService.showSuccess('Mission deleted');
        this.getMissions();
      },
      error: err => {
        NotificationService.showError('Failed to delete mission');
        console.error(err);
      }
    });
  }

}
