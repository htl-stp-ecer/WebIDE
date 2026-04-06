import { Component, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpService } from '../../services/http-service';
import { Mission } from '../../entities/Mission';
import { NotificationService } from '../../services/NotificationService';
import { Card } from 'primeng/card';
import { PrimeTemplate } from 'primeng/api';
import { ConfirmationService } from 'primeng/api';
import type { MenuItem } from 'primeng/api';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { Button } from 'primeng/button';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import {NgClass} from '@angular/common';
import {MissionStateService} from '../../services/mission-sate-service';
import { ContextMenu } from 'primeng/contextmenu';
import {ConfirmDialog} from 'primeng/confirmdialog';
import { Dialog } from 'primeng/dialog';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Skeleton } from 'primeng/skeleton';

@Component({
  selector: 'app-mission-panel',
  standalone: true,
  imports: [Card, PrimeTemplate, FormsModule, InputText, Button, DragDropModule, NgClass, ContextMenu, ConfirmDialog, Dialog, TranslateModule],
  templateUrl: './mission-panel.html',
  styleUrl: './mission-panel.scss',
  providers: [ConfirmationService]
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
  missionsLoading = true;
  missionDetailLoading = false;
  private contextMission?: Mission;
  private readonly missionStoragePrefix = 'webide:lastMission:';

  // Rename dialog state
  renameDialogVisible = false;
  renameName = '';
  private renameOriginalName = '';
  renameSubmitting = false;

  @ViewChild('missionMenu') missionMenu?: ContextMenu;

  constructor(
    private route: ActivatedRoute,
    private http: HttpService,
    private missionState: MissionStateService,
    private router: Router,
    private confirmationService: ConfirmationService,
    private translate: TranslateService
  ) {}

  ngOnInit(): void {
    this.projectUUID = this.route.snapshot.paramMap.get('uuid');
    this.getMissions();
  }

  private missionStorageKey(): string | null {
    return this.projectUUID ? `${this.missionStoragePrefix}${this.projectUUID}` : null;
  }

  private loadStoredMissionName(): string | null {
    const key = this.missionStorageKey();
    if (!key) return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private saveStoredMissionName(name: string | null): void {
    const key = this.missionStorageKey();
    if (!key) return;
    try {
      if (name) {
        localStorage.setItem(key, name);
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // ignore storage errors
    }
  }

  clearSelection(): void {
    const selection = window.getSelection();
    if (selection && selection.type !== 'None') {
      selection.removeAllRanges();
    }
  }

  backToProjects() {
    this.router.navigate(['/projects']);
  }

  getMissions(): void {
    this.missionsLoading = true;
    this.http.getAllMissions(this.projectUUID!).subscribe({
      next: result => {
        this.missions = result;
        this.missionState.setAllMissions(result);
        this.updateTimelineData();
        this.missionsLoading = false;
        if (result.length) {
          const storedName = this.loadStoredMissionName();
          const storedMission = storedName ? result.find(m => m.name === storedName) : undefined;
          if (storedMission) {
            this.getDetailedMission(storedMission.name);
          } else {
            if (storedName) {
              this.saveStoredMissionName(null);
            }
            this.getDetailedMission(result[0].name);
          }
        } else {
          this.currentMission = undefined;
          this.missionState.setMission(null);
          this.saveStoredMissionName(null);
        }
      },
      error: error => {
        this.missionsLoading = false;
        NotificationService.showError(
          this.translate.instant('MISSION.ERROR_LOAD_MISSIONS'),
          this.translate.instant('COMMON.ERROR')
        );
        console.log(error);
      }
    });
  }

  getDetailedMission(name: string) {
    this.missionDetailLoading = true;
    this.http.getDetailedMission(this.projectUUID!, name).subscribe({
      next: result => {
        this.currentMission = result;
        this.missionState.setMission(result);
        this.saveStoredMissionName(result.name ?? name);
        this.missionDetailLoading = false;
      }, error: error => {
        this.missionDetailLoading = false;
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
        NotificationService.showSuccess(
          this.translate.instant('MISSION.CREATE_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
        this.getMissions();
        this.addingMission = false;
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('MISSION.CREATE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
        console.error(err);
      }
    });
  }

  dropMiddle(event: CdkDragDrop<any[]>) {
    if (event.previousIndex === event.currentIndex) return;

    const mission = this.middleMissions[event.previousIndex];

    // Optimistic local update
    moveItemInArray(this.middleMissions, event.previousIndex, event.currentIndex);

    this.http.updateMissionOrder(this.projectUUID!, mission.name, event.currentIndex).subscribe({
      next: () => this.getMissions(),
      error: err => {
        // Revert local state on failure
        moveItemInArray(this.middleMissions, event.currentIndex, event.previousIndex);
        NotificationService.showError(
          this.translate.instant('MISSION.ORDER_UPDATE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
        console.error(err);
      }
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
        label: this.translate.instant('COMMON.RENAME'),
        icon: 'pi pi-pencil',
        command: () => this.renameMissionPrompt()
      },
      {
        label: this.translate.instant('COMMON.DELETE'),
        icon: 'pi pi-trash',
        command: () => this.deleteMissionConfirm()
      }
    ];
    this.missionMenu?.show(event);
  }

  private renameMissionPrompt() {
    if (!this.contextMission || !this.projectUUID) return;
    this.renameOriginalName = this.contextMission.name;
    this.renameName = this.renameOriginalName;
    this.renameDialogVisible = true;
  }

  renameMissionCancel() {
    this.renameDialogVisible = false;
    this.renameSubmitting = false;
  }

  renameMissionConfirm() {
    if (!this.projectUUID) return;
    const newName = this.renameName.trim();
    const oldName = this.renameOriginalName;
    if (!newName) {
      NotificationService.showError(
        this.translate.instant('MISSION.NAME_REQUIRED'),
        this.translate.instant('COMMON.ERROR')
      );
      return;
    }
    if (newName === oldName) {
      this.renameDialogVisible = false;
      return;
    }
    if (this.missions.some(m => m.name === newName)) {
      NotificationService.showError(
        this.translate.instant('MISSION.NAME_EXISTS'),
        this.translate.instant('COMMON.ERROR')
      );
      return;
    }
    this.renameSubmitting = true;
    this.http.renameMission(this.projectUUID, oldName, newName).subscribe({
      next: () => {
        NotificationService.showSuccess(
          this.translate.instant('MISSION.RENAME_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
        if (this.currentMission?.name === oldName) {
          this.currentMission = { ...this.currentMission, name: newName } as Mission;
          this.missionState.setMission(this.currentMission);
          this.saveStoredMissionName(newName);
        }
        this.getMissions();
        this.renameDialogVisible = false;
        this.renameSubmitting = false;
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('MISSION.RENAME_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
        console.error(err);
        this.renameSubmitting = false;
      }
    });
  }

  private deleteMissionConfirm() {
    if (!this.contextMission || !this.projectUUID) return;
    const name = this.contextMission.name;
    this.confirmationService.confirm({
      message: this.translate.instant('MISSION.CONFIRM_DELETE_MESSAGE'),
      header: this.translate.instant('COMMON.CONFIRM_DELETION'),
      icon: 'pi pi-exclamation-triangle',
      acceptButtonStyleClass: 'p-button-danger p-button-sm',
      rejectButtonStyleClass: 'p-button-secondary p-button-sm',
      accept: () => {
        this.http.deleteMission(this.projectUUID!, name).subscribe({
          next: () => {
            NotificationService.showSuccess(
              this.translate.instant('MISSION.DELETE_SUCCESS'),
              this.translate.instant('COMMON.SUCCESS')
            );
            if (this.loadStoredMissionName() === name) {
              this.saveStoredMissionName(null);
            }
            this.getMissions();
          },
          error: err => {
            NotificationService.showError(
              this.translate.instant('MISSION.DELETE_ERROR'),
              this.translate.instant('COMMON.ERROR')
            );
            console.error(err);
          }
        });
      }
    });
  }

}
