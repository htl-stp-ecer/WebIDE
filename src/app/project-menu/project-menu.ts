import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HttpService } from '../services/http-service';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { Button } from 'primeng/button';
import {NotificationService} from '../services/NotificationService';

@Component({
  selector: 'app-project-menu',
  standalone: true,
  imports: [FormsModule, InputText, Button],
  templateUrl: './project-menu.html',
  styleUrl: './project-menu.scss'
})
export class ProjectMenu implements OnInit {
  ip: string | null = "";
  connectionInfo: ConnectionInfo | undefined;
  tempName: string = ""
  editingName = false;

  constructor(private route: ActivatedRoute, private http: HttpService) {}

  ngOnInit() {
    this.ip = this.route.snapshot.paramMap.get('ip');

    this.http.getDeviceInfo(this.ip!).subscribe(deviceInfo => {
      this.connectionInfo = deviceInfo;
      this.tempName = deviceInfo.hostname
    });
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
    }
    )
  }
}
