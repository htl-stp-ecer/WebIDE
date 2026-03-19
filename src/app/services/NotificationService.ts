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

  private static normalizeDetail(detail: unknown): string {
    if (typeof detail === 'string') {
      return detail;
    }

    if (detail && typeof detail === 'object') {
      const errorDetail = this.extractDetail(detail as Record<string, unknown>);
      if (errorDetail) {
        return errorDetail;
      }
    }

    if (detail == null) {
      return this.defaultSummary('COMMON.ERROR');
    }

    return String(detail);
  }

  private static extractDetail(value: Record<string, unknown>): string | null {
    const directDetail = value['detail'];
    if (typeof directDetail === 'string' && directDetail.trim()) {
      return directDetail;
    }

    const nestedError = value['error'];
    if (nestedError && typeof nestedError === 'object') {
      return this.extractDetail(nestedError as Record<string, unknown>);
    }

    if (typeof nestedError === 'string' && nestedError.trim()) {
      return nestedError;
    }

    const directMessage = value['message'];
    if (typeof directMessage === 'string' && directMessage.trim() && !this.isHttpFailureMessage(directMessage)) {
      return directMessage;
    }

    const httpFallback = this.formatHttpFailure(value);
    if (httpFallback) {
      return httpFallback;
    }

    return null;
  }

  private static isHttpFailureMessage(message: string): boolean {
    return message.startsWith('Http failure response for ');
  }

  private static formatHttpFailure(value: Record<string, unknown>): string | null {
    const status = typeof value['status'] === 'number' ? value['status'] : null;
    const statusText = typeof value['statusText'] === 'string' ? value['statusText'].trim() : '';

    if (status === 0) {
      return 'Network request failed';
    }

    if (status && statusText && statusText !== 'Unknown Error') {
      return `Request failed (${status} ${statusText})`;
    }

    if (status) {
      return `Request failed (${status})`;
    }

    if (statusText && statusText !== 'Unknown Error') {
      return statusText;
    }

    return null;
  }

  static showError(detail: unknown, summary?: string) {
    this.ms.add({
      severity: 'error',
      summary: summary ?? this.defaultSummary('COMMON.ERROR'),
      detail: this.normalizeDetail(detail),
      life: 6000
    });
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
