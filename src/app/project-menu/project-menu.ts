import { Component, OnInit } from '@angular/core';
import {Router} from '@angular/router';
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

  projects: Project[] = [];

  constructor(
    private router: Router,
    private http: HttpService,
    private confirmationService: ConfirmationService,
    private translate: TranslateService
  ) {}

  ngOnInit() {
    this.http.getDeviceInfoDefault().subscribe(deviceInfo => {
      this.connectionInfo = deviceInfo;
      this.tempName = deviceInfo.hostname
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
        NotificationService.showSuccess(res.message);
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
    this.router.navigate([this.router.url + "/" + uuid]);
  }

  backToProjects() {
    this.router.navigate(['/']);
  }

}
