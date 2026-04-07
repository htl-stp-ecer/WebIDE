import {
  Component,
  computed,
  effect,
  HostListener,
  inject,
  Input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpService } from '../../services/http-service';
import { NotificationService } from '../../services/NotificationService';
import { MissionStateService } from '../../services/mission-sate-service';
import { CodeEditorComponent } from './code-editor';

@Component({
  selector: 'app-code-view',
  standalone: true,
  imports: [CommonModule, CodeEditorComponent],
  templateUrl: './code-view.html',
  styleUrl: './code-view.scss',
})
export class CodeView {
  @Input() projectUuid!: string;

  private http = inject(HttpService);
  private missionState = inject(MissionStateService);

  missionName = computed(() => this.missionState.currentMission()?.name ?? null);
  sourceCode = signal('');
  savedContent = '';
  isDirty = signal(false);
  isLoading = signal(false);
  isSaving = signal(false);
  loadError = signal('');

  constructor() {
    effect(() => {
      const name = this.missionName();
      if (name && this.projectUuid) {
        this.loadMissionSource(name);
      } else {
        this.sourceCode.set('');
        this.savedContent = '';
        this.isDirty.set(false);
        this.loadError.set('');
      }
    });
  }

  private loadMissionSource(missionName: string): void {
    this.isLoading.set(true);
    this.loadError.set('');
    this.isDirty.set(false);
    this.http.getMissionSource(this.projectUuid, missionName).subscribe({
      next: res => {
        this.sourceCode.set(res.source);
        this.savedContent = res.source;
        this.isLoading.set(false);
      },
      error: () => {
        this.loadError.set(`Failed to load source for "${missionName}"`);
        this.sourceCode.set('');
        this.savedContent = '';
        this.isLoading.set(false);
      },
    });
  }

  onContentChange(content: string): void {
    this.sourceCode.set(content);
    this.isDirty.set(content !== this.savedContent);
  }

  saveFile(): void {
    const name = this.missionName();
    if (!name || !this.isDirty() || this.isSaving()) return;
    this.isSaving.set(true);
    this.http.saveMissionSource(this.projectUuid, name, this.sourceCode()).subscribe({
      next: () => {
        this.savedContent = this.sourceCode();
        this.isDirty.set(false);
        this.isSaving.set(false);
      },
      error: () => {
        NotificationService.showError('Failed to save mission source', 'Save Error');
        this.isSaving.set(false);
      },
    });
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      this.saveFile();
    }
  }
}
