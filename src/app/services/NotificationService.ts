// src/app/services/notification.service.ts
import { Injectable } from '@angular/core';
import { MessageService } from 'primeng/api';
import { TranslateService } from '@ngx-translate/core';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private static messageService: MessageService | null = null;
  private static translateService: TranslateService | null = null;

  constructor(messageService: MessageService, translateService: TranslateService) {
    NotificationService.messageService = messageService;
    NotificationService.translateService = translateService;
  }

  private static get ms(): MessageService {
    if (!this.messageService) {
      throw new Error('NotificationService not initialized yet.');
    }
    return this.messageService;
  }

  private static defaultSummary(key: 'COMMON.ERROR' | 'COMMON.SUCCESS' | 'COMMON.INFO' | 'COMMON.WARNING'): string {
    const fallbackMap = {
      'COMMON.ERROR': 'Error',
      'COMMON.SUCCESS': 'Success',
      'COMMON.INFO': 'Info',
      'COMMON.WARNING': 'Warning'
    } as const;

    if (!this.translateService) {
      return fallbackMap[key];
    }
    return this.translateService.instant(key) || fallbackMap[key];
  }

  static showError(detail: string, summary?: string) {
    this.ms.add({ severity: 'error', summary: summary ?? this.defaultSummary('COMMON.ERROR'), detail, life: 6000 });
  }
  static showSuccess(detail: string, summary?: string) {
    this.ms.add({ severity: 'success', summary: summary ?? this.defaultSummary('COMMON.SUCCESS'), detail, life: 4000 });
  }
  static showInfo(detail: string, summary?: string) {
    this.ms.add({ severity: 'info', summary: summary ?? this.defaultSummary('COMMON.INFO'), detail, life: 4000 });
  }
  static showWarn(detail: string, summary?: string) {
    this.ms.add({ severity: 'warn', summary: summary ?? this.defaultSummary('COMMON.WARNING'), detail, life: 5000 });
  }
}
