import {
  Component,
  HostListener,
  Input,
  OnChanges,
  OnInit,
  signal,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpService } from '../../services/http-service';
import { NotificationService } from '../../services/NotificationService';
import { CodeEditorComponent } from './code-editor';

interface FileItem {
  path: string;
  name: string;
}

@Component({
  selector: 'app-code-view',
  standalone: true,
  imports: [CommonModule, FormsModule, CodeEditorComponent],
  templateUrl: './code-view.html',
  styleUrl: './code-view.scss',
})
export class CodeView implements OnInit, OnChanges {
  @Input() projectUuid!: string;
  @Input() dark = false;

  files = signal<FileItem[]>([]);
  selectedFile = signal<FileItem | null>(null);
  fileContent = signal('');
  savedContent = '';
  isDirty = signal(false);
  isLoading = signal(false);
  isSaving = signal(false);
  loadError = signal('');

  constructor(
    private http: HttpService,
    private notificationService: NotificationService,
  ) {}

  ngOnInit(): void {
    this.loadFileList();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['projectUuid'] && !changes['projectUuid'].firstChange) {
      this.loadFileList();
    }
  }

  private loadFileList(): void {
    if (!this.projectUuid) return;
    this.http.listProjectFiles(this.projectUuid).subscribe({
      next: items => {
        this.files.set(items);
        // Auto-open first file
        if (items.length > 0 && !this.selectedFile()) {
          this.openFile(items[0]);
        }
      },
      error: () => {
        this.loadError.set('Failed to load project files.');
      },
    });
  }

  openFile(file: FileItem): void {
    if (this.selectedFile()?.path === file.path) return;
    this.isLoading.set(true);
    this.loadError.set('');
    this.http.getProjectFileContent(this.projectUuid, file.path).subscribe({
      next: res => {
        this.selectedFile.set(file);
        this.fileContent.set(res.content);
        this.savedContent = res.content;
        this.isDirty.set(false);
        this.isLoading.set(false);
      },
      error: () => {
        this.loadError.set(`Failed to load ${file.name}`);
        this.isLoading.set(false);
      },
    });
  }

  onContentChange(content: string): void {
    this.fileContent.set(content);
    this.isDirty.set(content !== this.savedContent);
  }

  saveFile(): void {
    const file = this.selectedFile();
    if (!file || !this.isDirty() || this.isSaving()) return;
    this.isSaving.set(true);
    this.http.updateProjectFileContent(this.projectUuid, file.path, this.fileContent()).subscribe({
      next: () => {
        this.savedContent = this.fileContent();
        this.isDirty.set(false);
        this.isSaving.set(false);
      },
      error: () => {
        NotificationService.showError('Failed to save file', 'Save Error');
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

  /** Group files by their parent directory for display. */
  get fileTree(): { dir: string; files: FileItem[] }[] {
    const map = new Map<string, FileItem[]>();
    for (const f of this.files()) {
      const parts = f.path.split('/');
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
      if (!map.has(dir)) map.set(dir, []);
      map.get(dir)!.push(f);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, files]) => ({ dir, files }));
  }
}
