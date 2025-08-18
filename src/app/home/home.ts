import { Component } from '@angular/core';
import {InputGroup} from 'primeng/inputgroup';
import {InputText} from 'primeng/inputtext';
import {Button} from 'primeng/button';
import {FormsModule} from '@angular/forms';
import {Card} from 'primeng/card';
import {HttpService} from '../services/http-service';
import {MessageService} from 'primeng/api';

@Component({
  selector: 'app-home',
  imports: [
    InputGroup,
    InputText,
    Button,
    FormsModule,
    Card,
  ],
  templateUrl: './home.html',
  styleUrl: './home.scss'
})
export class Home {
  ip: string = ""
  previousConnections: ConnectionInfo[] = []


  constructor(private httpService: HttpService, private messageService: MessageService) {
    const connections = localStorage.getItem("previousConnections");
    if (connections) {
      try {
        this.previousConnections = JSON.parse(connections) as ConnectionInfo[];
      } catch (e) {
        console.error('Error parsing previousConnections from localStorage', e);
        this.previousConnections = [];
      }
    }

  }

  tryConnecting(ip: string) {
    this.httpService.getDeviceInfo(ip).subscribe({
      next: (res) => {
        res.ip = ip;
        this.previousConnections.push(res);
        this.saveToLocalStorage();
      },
      error: (err) => {
        console.error(err);
        this.showError('Failed to connect to device');
      }
    });
  }

  removeConnection(ip: string) {
    this.previousConnections = this.previousConnections.filter(c => c.ip !== ip);
    this.saveToLocalStorage();
  }

  saveToLocalStorage() {
    localStorage.setItem("previousConnections", JSON.stringify(this.previousConnections));
  }

  showError(detail: string) {
    this.messageService.add({ severity: 'error', summary: 'Error', detail, life: 6000 });
  }

}
