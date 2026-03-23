import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpService } from '../services/http-service';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { Button } from 'primeng/button';
import { NotificationService } from '../services/NotificationService';
import { ConfirmDialog } from 'primeng/confirmdialog';
import { ConfirmationService } from 'primeng/api';
import { SlicePipe } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { decodeRouteIp } from '../services/route-ip-serializer';
import { Skeleton } from 'primeng/skeleton';

@Component({
  selector: 'app-project-menu',
  standalone: true,
  imports: [FormsModule, InputText, Button, ConfirmDialog, TranslateModule, Skeleton, SlicePipe],
  templateUrl: './project-menu.html',
  styleUrl: './project-menu.scss',
  providers: [ConfirmationService]
})
export class ProjectMenu implements OnInit {
  connectionInfo: ConnectionInfo | undefined;
  tempName: string = "";
  editingName = false;
  creatingProject = false;
  creatingProjectPending = false;
  newProjectName: string = "";

  loading = true;
  projectsLoading = true;

  projects: Project[] = [];

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private http: HttpService,
    private confirmationService: ConfirmationService,
    private translate: TranslateService
  ) {
    const ipParam = this.route.snapshot.paramMap.get('ip');
    const decodedIp = decodeRouteIp(ipParam);
    if (decodedIp) {
      this.http.setDeviceBase(decodedIp);
    } else {
      this.http.clearDeviceBase();
      this.loading = false;
      this.projectsLoading = false;
      return;
    }
  }

  ngOnInit() {
    this.http.getDeviceInfoDefault().subscribe({
      next: deviceInfo => {
        this.connectionInfo = deviceInfo;
        this.tempName = deviceInfo.hostname;
        this.loading = false;
      },
      error: () => {
        this.loading = false;
      }
    });

    this.loadProjects();
  }

  // Name editing
  enableEdit() {
    this.editingName = true;
  }

  disableEdit() {
    this.editingName = false;
    this.tempName = this.connectionInfo?.hostname ?? "";
  }

  finishEdit() {
    if (!this.tempName.trim()) {
      return;
    }
    this.editingName = false;
    this.connectionInfo!.hostname = this.tempName;
    this.saveHostname(this.connectionInfo!.hostname);
  }

  private saveHostname(newName: string) {
    this.http.changeHostname(newName).subscribe({
      next: res => {
        this.connectionInfo = res;
        this.tempName = res.hostname;
        NotificationService.showSuccess(
          this.translate.instant('PROJECT_MENU.SAVE_HOSTNAME_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('PROJECT_MENU.SAVE_HOSTNAME_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
        console.error(err);
      }
    });
  }

  confirmDelete(uuid: string) {
    this.confirmationService.confirm({
      message: this.translate.instant('DEVICE_PROJECTS.CONFIRM_DELETE_MESSAGE'),
      header: this.translate.instant('COMMON.CONFIRM_DELETION'),
      icon: 'pi pi-exclamation-triangle',
      acceptButtonStyleClass: 'p-button-danger p-button-sm',
      rejectButtonStyleClass: 'p-button-secondary p-button-sm',
      accept: () => {
        this.deleteProject(uuid);
      }
    });
  }

  startCreateProject() {
    this.creatingProject = true;
  }

  cancelCreateProject() {
    if (this.creatingProjectPending) {
      return;
    }
    this.creatingProject = false;
    this.newProjectName = "";
  }

  createProject() {
    const name = this.newProjectName.trim();
    if (!name) {
      NotificationService.showError(
        this.translate.instant('PROJECT_MENU.NAME_REQUIRED'),
        this.translate.instant('COMMON.ERROR')
      );
      return;
    }

    if (this.creatingProjectPending) {
      return;
    }

    this.creatingProjectPending = true;
    this.http.createDeviceProject(name).subscribe({
      next: project => {
        NotificationService.showSuccess(
          this.translate.instant('PROJECT_MENU.CREATE_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
        this.projects = [project, ...this.projects.filter(entry => entry.uuid !== project.uuid)];
        this.creatingProject = false;
        this.creatingProjectPending = false;
        this.newProjectName = "";
      },
      error: err => {
        this.creatingProjectPending = false;
        NotificationService.showError(
          this.translate.instant('PROJECT_MENU.CREATE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
        console.error(err);
      }
    });
  }

  private deleteProject(uuid: string) {
    this.http.deleteDeviceProject(uuid).subscribe({
      next: () => {
        NotificationService.showSuccess(
          this.translate.instant('DEVICE_PROJECTS.DELETE_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
        this.projects = this.projects.filter(project => project.uuid !== uuid);
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('DEVICE_PROJECTS.DELETE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
        console.error(err);
      }
    });
  }

  backToProjects() {
    this.router.navigate(['/']);
  }

  private loadProjects() {
    this.http.getDeviceProjects().subscribe({
      next: projects => {
        this.projects = projects;
        this.projectsLoading = false;
      },
      error: () => {
        this.projectsLoading = false;
      }
    });
  }
}
