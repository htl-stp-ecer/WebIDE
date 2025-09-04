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

@Component({
  selector: 'app-project-menu',
  standalone: true,
  imports: [FormsModule, InputText, Button, Card, ConfirmDialog, NgClass],
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
    private route: ActivatedRoute,
    private router: Router,
    private http: HttpService,
    private confirmationService: ConfirmationService
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
        NotificationService.showError("Could not save hostname")
        console.log(err)
      }
    })
  }

  confirmDelete(uuid: string) {
    this.confirmationService.confirm({
      message: 'Are you sure you want to delete this project?',
      header: 'Confirm Deletion',
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
        NotificationService.showSuccess("Project deleted successfully.");
        this.projects = this.projects.filter(project => project.uuid !== uuid)
      },
      error: err => {
        NotificationService.showError("Could not delete project")
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
      NotificationService.showError("Project name cannot be empty");
      return;
    }

    this.http.createProject(this.newProjectName).subscribe({
      next: (project: Project) => {
        NotificationService.showSuccess("Project created successfully.");
        this.projects = [...this.projects, project];
        this.addingProject = false;
      },
      error: err => {
        NotificationService.showError("Could not create project");
        console.error(err);
      }
    });
  }

  redirectToProject(uuid: string) {
    this.router.navigate([this.router.url + "/" + uuid]);
  }
}
