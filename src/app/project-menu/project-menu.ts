import { Component, OnInit } from '@angular/core';
import {ActivatedRoute, Router} from '@angular/router';
import { HttpService } from '../services/http-service';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { Button } from 'primeng/button';
import { NotificationService } from '../services/NotificationService';
import { Card } from 'primeng/card';
import { ConfirmDialog } from 'primeng/confirmdialog';
import { ConfirmationService } from 'primeng/api';
import {NgClass} from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { decodeRouteIp, encodeRouteIp } from '../services/route-ip-serializer';

@Component({
  selector: 'app-project-menu',
  standalone: true,
  imports: [FormsModule, InputText, Button, Card, ConfirmDialog, NgClass, TranslateModule],
  templateUrl: './project-menu.html',
  styleUrl: './project-menu.scss',
  providers: [ConfirmationService] // required for PrimeNG
})
export class ProjectMenu implements OnInit {
  connectionInfo: ConnectionInfo | undefined;
  tempName: string = ""
  editingName = false;

  tempWidth: string = "";
  tempLength: string = "";
  editingDimensions = false;

  projects: Project[] = [];

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private http: HttpService,
    private confirmationService: ConfirmationService,
    private translate: TranslateService
  ) {}

  ngOnInit() {
    this.http.getDeviceInfoDefault().subscribe(deviceInfo => {
      this.connectionInfo = deviceInfo;
      this.tempName = deviceInfo.hostname
      this.tempWidth = this.toDimensionString(deviceInfo.width_cm);
      this.tempLength = this.toDimensionString(deviceInfo.length_cm);
    });

    this.http.getAllProjects().subscribe(projects => {
      this.projects = projects;
    })
  }

  enableEdit() {
    this.editingName = true;
  }

  disableEdit() {
    this.editingName = false;
  }

  finishEdit() {
    this.editingName = false;
    this.connectionInfo!.hostname = this.tempName;
    this.saveHostname(this.connectionInfo!.hostname);
  }

  saveHostname(newName: string) {
    this.http.changeHostname(newName).subscribe({
      next: res => {
        this.connectionInfo = res;
        this.tempName = res.hostname;
        this.tempWidth = this.toDimensionString(res.width_cm);
        this.tempLength = this.toDimensionString(res.length_cm);
        NotificationService.showSuccess(
          this.translate.instant('PROJECT_MENU.SAVE_HOSTNAME_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('PROJECT_MENU.SAVE_HOSTNAME_ERROR'),
          this.translate.instant('COMMON.ERROR')
        )
        console.log(err)
      }
    })
  }

  get canSaveDimensions(): boolean {
    if (!this.connectionInfo) {
      return false;
    }

    return this.parseDimension(this.tempWidth) !== undefined &&
      this.parseDimension(this.tempLength) !== undefined;
  }

  enableDimensionsEdit() {
    if (!this.connectionInfo) {
      return;
    }

    this.editingDimensions = true;
    this.tempWidth = this.toDimensionString(this.connectionInfo.width_cm);
    this.tempLength = this.toDimensionString(this.connectionInfo.length_cm);
  }

  cancelDimensionsEdit() {
    this.editingDimensions = false;
    this.tempWidth = this.toDimensionString(this.connectionInfo?.width_cm);
    this.tempLength = this.toDimensionString(this.connectionInfo?.length_cm);
  }

  saveDimensions() {
    const width = this.parseDimension(this.tempWidth);
    const length = this.parseDimension(this.tempLength);

    if (width === undefined || length === undefined) {
      NotificationService.showError(
        this.translate.instant('PROJECT_MENU.INVALID_DIMENSIONS'),
        this.translate.instant('COMMON.ERROR')
      );
      return;
    }

    this.http.updateDeviceDimensions(width, length).subscribe({
      next: (info: ConnectionInfo) => {
        this.connectionInfo = info;
        this.tempWidth = this.toDimensionString(info.width_cm);
        this.tempLength = this.toDimensionString(info.length_cm);
        this.editingDimensions = false;
        NotificationService.showSuccess(
          this.translate.instant('PROJECT_MENU.SAVE_DIMENSIONS_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('PROJECT_MENU.SAVE_DIMENSIONS_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
        console.error(err);
      }
    })
  }

  private parseDimension(value: string): number | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const parsed = Number(value);
    if (Number.isNaN(parsed) || parsed < 0) {
      return undefined;
    }

    return parsed;
  }

  private toDimensionString(value: number | undefined | null): string {
    return value === undefined || value === null ? '' : value.toString();
  }

  formatDimension(value: number | undefined | null): string {
    return value === undefined || value === null ? '--' : value.toString();
  }

  confirmDelete(uuid: string) {
    this.confirmationService.confirm({
      message: this.translate.instant('PROJECT_MENU.CONFIRM_DELETE_MESSAGE'),
      header: this.translate.instant('COMMON.CONFIRM_DELETION'),
      icon: 'pi pi-exclamation-triangle',
      acceptButtonStyleClass: 'p-button-danger p-button-sm',
      rejectButtonStyleClass: 'p-button-secondary p-button-sm',
      accept: () => {
        this.deleteProject(uuid);
      }
    });
  }

  private deleteProject(uuid: string) {
    this.http.deleteProject(uuid).subscribe({
      next: () => {
        NotificationService.showSuccess(
          this.translate.instant('PROJECT_MENU.DELETE_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
        this.projects = this.projects.filter(project => project.uuid !== uuid)
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('PROJECT_MENU.DELETE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        )
        console.log(err)
      }
    })
  }

  addingProject = false;
  newProjectName = "";

  enableAddProject() {
    this.addingProject = true;
    this.newProjectName = "";
  }

  cancelAddProject() {
    this.addingProject = false;
  }

  createProject() {
    if (!this.newProjectName.trim()) {
      NotificationService.showError(
        this.translate.instant('PROJECT_MENU.NAME_REQUIRED'),
        this.translate.instant('COMMON.ERROR')
      );
      return;
    }

    this.http.createProject(this.newProjectName).subscribe({
      next: (project: Project) => {
        NotificationService.showSuccess(
          this.translate.instant('PROJECT_MENU.CREATE_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
        this.projects = [...this.projects, project];
        this.addingProject = false;
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('PROJECT_MENU.CREATE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
        console.error(err);
      }
    });
  }

  redirectToProject(uuid: string) {
    const ipParam = this.route.snapshot.paramMap.get('ip');
    const decodedIp = decodeRouteIp(ipParam);
    if (!decodedIp) {
      console.warn('Cannot redirect to project view: missing IP route parameter');
      return;
    }

    this.router.navigate(['/', encodeRouteIp(decodedIp), 'projects', uuid]);
  }

  backToProjects() {
    this.router.navigate(['/']);
  }

}
