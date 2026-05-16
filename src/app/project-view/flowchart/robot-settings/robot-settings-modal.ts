import {
  Component,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnInit,
  Output,
  signal,
  SimpleChanges,
  WritableSignal
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import { Button } from 'primeng/button';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {HttpService} from '../../../services/http-service';
import {KeybindingsService, StepKeybinding} from '../../../services/keybindings-service';
import {StepsStateService} from '../../../services/steps-state-service';
import {Step} from '../models';
import {FlowOrientation} from '../models';

type SettingsTab = 'project' | 'keybindings';

interface StepIndexStatus {
  status: string;
  count?: number;
  last_indexed_at?: string;
  error?: string;
}

@Component({
  selector: 'app-robot-settings-modal',
  standalone: true,
  imports: [FormsModule, NgClass, Dialog, InputText, Button, TranslateModule],
  templateUrl: './robot-settings-modal.html',
  styleUrl: './robot-settings-modal.scss'
})
export class RobotSettingsModal implements OnInit, OnChanges {
  @Input() visible = false;
  @Input() projectUuid: string | null = null;
  @Input() orientation: WritableSignal<FlowOrientation> | null = null;
  @Input() useAutoLayout = false;
  @Input() set initialTab(tab: SettingsTab | null) {
    if (tab) {
      this.activeTab.set(tab);
    }
  }
  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() orientationChange = new EventEmitter<FlowOrientation>();
  @Output() useAutoLayoutChange = new EventEmitter<boolean>();

  readonly activeTab = signal<SettingsTab>('project');

  stepIndexStatus?: StepIndexStatus;
  stepIndexLoading = false;
  stepIndexRefreshing = false;
  private stepIndexPoll?: ReturnType<typeof setTimeout>;

  constructor(
    private http: HttpService,
    private translate: TranslateService,
    public keybindingsService: KeybindingsService,
    private stepsStateService: StepsStateService
  ) {}

  ngOnInit() {
    this.loadStepIndexStatus();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['visible'] && changes['visible'].currentValue) {
      this.loadStepIndexStatus();
    }
  }

  private loadStepIndexStatus() {
    if (this.stepIndexPoll) {
      clearTimeout(this.stepIndexPoll);
      this.stepIndexPoll = undefined;
    }
    this.stepIndexLoading = true;
    const wasIndexing = this.stepIndexStatus?.status === 'indexing';
    this.http.getStepIndexStatus().subscribe({
      next: status => {
        this.stepIndexStatus = status;
        this.stepIndexLoading = false;
        if (status.status === 'indexing') {
          this.stepIndexPoll = setTimeout(() => this.loadStepIndexStatus(), 2000);
        } else if (wasIndexing && status.status === 'ready') {
          // Indexing just finished - trigger step panel refresh
          this.stepsStateService.triggerRefresh();
        }
      },
      error: () => {
        this.stepIndexLoading = false;
      }
    });
  }

  refreshStepIndex(forceClear: boolean = false) {
    const previousStatus = this.stepIndexStatus ? { ...this.stepIndexStatus } : undefined;
    this.stepIndexRefreshing = true;
    // Mark current status as indexing so the polling logic knows to trigger refresh when done
    if (this.stepIndexStatus) {
      this.stepIndexStatus = { ...this.stepIndexStatus, status: 'indexing' };
    }
    this.http.refreshStepIndex(forceClear).subscribe({
      next: status => {
        this.stepIndexStatus = status;
        this.stepIndexRefreshing = false;
        if (status.status === 'indexing') {
          this.loadStepIndexStatus();
        } else if (status.status === 'ready') {
          // Indexing completed immediately (rare but possible)
          this.stepsStateService.triggerRefresh();
        }
      },
      error: () => {
        this.stepIndexRefreshing = false;
        this.stepIndexStatus = previousStatus;
        this.loadStepIndexStatus();
      }
    });
  }

  clearStepIndexCache() {
    this.stepIndexRefreshing = true;
    this.http.clearStepIndex().subscribe({
      next: status => {
        this.stepIndexStatus = status;
        this.stepIndexRefreshing = false;
        // Trigger refresh to show empty state in step panel
        this.stepsStateService.triggerRefresh();
      },
      error: () => {
        this.stepIndexRefreshing = false;
      }
    });
  }

  getStepIndexStatusLabel() {
    if (!this.stepIndexStatus) return this.translate.instant('STEP_INDEX.STATUS_UNKNOWN');
    switch (this.stepIndexStatus.status) {
      case 'indexing':
        return this.translate.instant('STEP_INDEX.STATUS_INDEXING');
      case 'ready':
        return this.translate.instant('STEP_INDEX.STATUS_READY');
      case 'error':
        return this.translate.instant('STEP_INDEX.STATUS_ERROR');
      default:
        return this.translate.instant('STEP_INDEX.STATUS_EMPTY');
    }
  }

  closeModal() {
    this.visible = false;
    this.visibleChange.emit(false);
  }

  // Layout settings
  readonly orientationOptions: { label: string; value: FlowOrientation }[] = [
    {label: '↕', value: 'vertical'},
    {label: '↔', value: 'horizontal'},
  ];

  get currentOrientation(): FlowOrientation {
    return this.orientation?.() ?? 'vertical';
  }

  onOrientationChange(value: FlowOrientation): void {
    this.orientationChange.emit(value);
  }

  onAutoLayoutChange(value: boolean): void {
    this.useAutoLayoutChange.emit(value);
  }

  // Keybindings
  readonly recordingFor = signal<Step | null>(null);
  readonly recordedKey = signal<string | null>(null);
  readonly keybindingsSubTab = signal<'recent' | 'all' | 'bindings'>('recent');
  keybindingFilter = '';

  get recentSteps() {
    return this.keybindingsService.recentSteps();
  }

  get keybindings() {
    return this.keybindingsService.stepKeybindings();
  }

  filteredStepsForKeybindings(): Step[] {
    const steps = this.stepsStateService.currentSteps() ?? [];
    if (!this.keybindingFilter.trim()) {
      return steps;
    }
    const filter = this.keybindingFilter.toLowerCase();
    return steps.filter(s => s.name.toLowerCase().includes(filter));
  }

  getKeybindingForStep(step: Step): string | null {
    return this.keybindingsService.getKeybindingForStep(step);
  }

  formatKeybinding(keybind: string): string {
    return this.keybindingsService.formatKeybinding(keybind);
  }

  startRecordingKeybinding(step: Step): void {
    this.recordingFor.set(step);
    this.recordedKey.set(null);
  }

  cancelRecording(): void {
    this.recordingFor.set(null);
    this.recordedKey.set(null);
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDownForRecording(event: KeyboardEvent): void {
    if (!this.recordingFor()) return;

    event.preventDefault();
    event.stopPropagation();

    // Ignore single modifier keys
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
      return;
    }

    // Escape cancels recording
    if (event.key === 'Escape') {
      this.cancelRecording();
      return;
    }

    const keybind = this.keybindingsService.parseKeyEvent(event);

    // Require at least one modifier for non-function keys
    const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
    const isFunctionKey = event.key.startsWith('F') && event.key.length <= 3;

    if (!hasModifier && !isFunctionKey) {
      return;
    }

    this.recordedKey.set(keybind);
  }

  saveRecordedKeybinding(): void {
    const step = this.recordingFor();
    const keybind = this.recordedKey();
    if (step && keybind) {
      this.keybindingsService.setStepKeybinding(step, keybind);
    }
    this.cancelRecording();
  }

  removeKeybinding(step: Step): void {
    this.keybindingsService.removeStepKeybinding(step);
  }

  removeKeybindingByBinding(binding: StepKeybinding): void {
    const steps = this.stepsStateService.currentSteps() ?? [];
    const step = steps.find(
      s => s.name === binding.stepName &&
           (s.import ?? null) === binding.stepImport &&
           s.file === binding.stepFile
    );
    if (step) {
      this.keybindingsService.removeStepKeybinding(step);
    } else {
      this.keybindingsService.setStepKeybinding({
        name: binding.stepName,
        import: binding.stepImport,
        file: binding.stepFile,
        arguments: []
      }, '');
    }
  }

  clearAllKeybindings(): void {
    this.keybindingsService.clearAllKeybindings();
  }
}
