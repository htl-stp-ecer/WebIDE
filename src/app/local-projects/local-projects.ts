import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Button } from 'primeng/button';
import { ConfirmDialog } from 'primeng/confirmdialog';
import { ConfirmationService } from 'primeng/api';
import { SlicePipe } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Skeleton } from 'primeng/skeleton';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';

import { HttpService } from '../services/http-service';
import { NotificationService } from '../services/NotificationService';
import { ProjectCollisionCompareComponent } from './project-collision-compare/project-collision-compare';

@Component({
  selector: 'app-local-projects',
  standalone: true,
  imports: [Button, ConfirmDialog, TranslateModule, Skeleton, SlicePipe, FormsModule, InputText, ProjectCollisionCompareComponent],
  templateUrl: './local-projects.html',
  styleUrl: './local-projects.scss',
  providers: [ConfirmationService]
})
export class LocalProjects implements OnInit {
  projectsLoading = true;
  projects: Project[] = [];
  localBackendPort = '';
  compareDialogVisible = false;
  creatingProject = false;
  creatingProjectPending = false;
  newProjectName = '';

  constructor(
    private router: Router,
    private http: HttpService,
    private confirmationService: ConfirmationService,
    private translate: TranslateService
  ) {}

  ngOnInit() {
    this.http.clearDeviceBase();
    this.localBackendPort = this.http.getLocalBackendPort();
    this.loadProjects();
  }

  private loadProjects() {
    this.projectsLoading = true;
    this.http.getAllProjects().subscribe({
      next: projects => {
        this.projects = projects;
        this.projectsLoading = false;
      },
      error: () => {
        this.projects = [];
        this.projectsLoading = false;
      }
    });
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
        this.projects = this.projects.filter(project => project.uuid !== uuid);
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('PROJECT_MENU.DELETE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
        console.error(err);
      }
    });
  }

  formatPiAddress(project: Project): string {
    const connection = project.connection;
    if (!connection?.pi_address) {
      return this.translate.instant('LOCAL_PROJECTS.PI_ADDRESS_UNSET');
    }
    return connection.pi_port ? `${connection.pi_address}:${connection.pi_port}` : connection.pi_address;
  }

  redirectToProject(uuid: string) {
    this.router.navigate(['/projects', uuid]);
  }

  backToProjects() {
    this.router.navigate(['/']);
  }

  applyLocalBackendPort() {
    const before = this.http.getLocalBackendPort();
    this.http.setLocalBackendPort(this.localBackendPort);
    this.localBackendPort = this.http.getLocalBackendPort();
    if (this.localBackendPort !== before) {
      this.loadProjects();
    }
  }

  openCompareDialog() {
    this.compareDialogVisible = true;
  }

  closeCompareDialog() {
    this.compareDialogVisible = false;
  }

  startCreateProject() {
    this.creatingProject = true;
  }

  cancelCreateProject() {
    if (this.creatingProjectPending) {
      return;
    }
    this.creatingProject = false;
    this.newProjectName = '';
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
    this.http.createProject(name).subscribe({
      next: project => {
        NotificationService.showSuccess(
          this.translate.instant('PROJECT_MENU.CREATE_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
        this.projects = [project, ...this.projects.filter(entry => entry.uuid !== project.uuid)];
        this.creatingProjectPending = false;
        this.creatingProject = false;
        this.newProjectName = '';
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
}
