import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HttpService } from '../services/http-service';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { Button } from 'primeng/button';
import { NotificationService } from '../services/NotificationService';
import { Card } from 'primeng/card';
import { ConfirmDialog } from 'primeng/confirmdialog';
import { ConfirmationService } from 'primeng/api';

@Component({
  selector: 'app-project-menu',
  standalone: true,
  imports: [FormsModule, InputText, Button, Card, ConfirmDialog],
  templateUrl: './project-menu.html',
  styleUrl: './project-menu.scss',
  providers: [ConfirmationService] // required for PrimeNG
})
export class ProjectMenu implements OnInit {
  ip: string | null = "";
  connectionInfo: ConnectionInfo | undefined;
  tempName: string = ""
  editingName = false;

  projects: Project[] = [];

  constructor(
    private route: ActivatedRoute,
    private http: HttpService,
    private confirmationService: ConfirmationService
  ) {}

  ngOnInit() {
    this.ip = this.route.snapshot.paramMap.get('ip');

    this.http.getDeviceInfo(this.ip!).subscribe(deviceInfo => {
      this.connectionInfo = deviceInfo;
      this.tempName = deviceInfo.hostname
    });

    this.http.getAllProjects(this.ip!).subscribe(projects => {
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
    this.http.changeHostname(this.ip!, newName).subscribe({
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
    this.http.deleteProject(this.ip!, uuid).subscribe({
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

    this.http.createProject(this.ip!, this.newProjectName).subscribe({
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

}
