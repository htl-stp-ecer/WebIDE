import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Tooltip } from 'primeng/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import type { RunLogEntry } from '../flowchart-run-manager';

@Component({
  selector: 'app-run-log-panel',
  standalone: true,
  imports: [DatePipe, Tooltip, TranslateModule],
  templateUrl: './run-log-panel.html',
  styleUrl: './run-log-panel.scss',
})
export class RunLogPanel implements AfterViewInit, OnChanges {
  @Input() entries: RunLogEntry[] = [];
  @Input() isRunning = false;
  @Input() fullscreen = false;
  @Output() fullscreenToggle = new EventEmitter<void>();

  @ViewChild('logScroll') logScroll?: ElementRef<HTMLDivElement>;

  private autoScroll = true;
  private pendingScroll = false;

  ngAfterViewInit(): void {
    this.requestScrollToBottom();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['entries']) {
      this.requestScrollToBottom();
    }
  }

  onScroll(): void {
    const el = this.logScroll?.nativeElement;
    if (!el) return;
    const threshold = 16;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.autoScroll = distance <= threshold;
  }

  private requestScrollToBottom(): void {
    if (!this.autoScroll || this.pendingScroll) return;
    this.pendingScroll = true;
    requestAnimationFrame(() => {
      this.pendingScroll = false;
      if (this.autoScroll) {
        this.scrollToBottom();
      }
    });
  }

  private scrollToBottom(): void {
    const el = this.logScroll?.nativeElement;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }
}
