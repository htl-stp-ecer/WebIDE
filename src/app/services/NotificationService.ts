// src/app/services/notification.service.ts
import { Injectable } from '@angular/core';
import { MessageService } from 'primeng/api';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private static messageService: MessageService | null = null;

  constructor(messageService: MessageService) {
    NotificationService.messageService = messageService;
  }

  private static get ms(): MessageService {
    if (!this.messageService) {
      throw new Error('NotificationService not initialized yet.');
    }
    return this.messageService;
  }

  static showError(detail: string, summary = 'Error') {
    this.ms.add({ severity: 'error', summary, detail, life: 6000 });
  }
  static showSuccess(detail: string, summary = 'Success') {
    this.ms.add({ severity: 'success', summary, detail, life: 4000 });
  }
  static showInfo(detail: string, summary = 'Info') {
    this.ms.add({ severity: 'info', summary, detail, life: 4000 });
  }
  static showWarn(detail: string, summary = 'Warning') {
    this.ms.add({ severity: 'warn', summary, detail, life: 5000 });
  }
}
