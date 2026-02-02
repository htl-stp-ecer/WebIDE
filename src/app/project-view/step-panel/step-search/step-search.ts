import {
  Component,
  ElementRef,
  EventEmitter,
  Output,
  signal,
  ViewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-step-search',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="step-search-container">
      <div class="relative">
        <i class="pi pi-search search-icon"></i>
        <input
          #searchInput
          type="text"
          class="w-full pl-8 pr-8 py-2 rounded border border-gray-300 dark:border-gray-600
                 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                 placeholder-gray-500 dark:placeholder-gray-400
                 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          placeholder="Filter steps..."
          [ngModel]="searchQuery()"
          (ngModelChange)="onSearchInput($event)"
          (keydown.escape)="clearSearch()"
        />
        @if (searchQuery()) {
          <button
            type="button"
            class="clear-btn"
            (click)="clearSearch()">
            <i class="pi pi-times"></i>
          </button>
        }
      </div>
    </div>
  `,
  styles: [`
    .step-search-container {
      margin-bottom: 0.75rem;
    }

    .search-icon {
      position: absolute;
      left: 10px;
      top: 50%;
      transform: translateY(-50%);
      color: #9ca3af;
      font-size: 12px;
      pointer-events: none;
    }

    .clear-btn {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      color: #9ca3af;
      cursor: pointer;
      padding: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: color 0.15s, background 0.15s;

      &:hover {
        color: #6b7280;
        background: rgba(0, 0, 0, 0.05);
      }

      i {
        font-size: 10px;
      }
    }

    :host-context(.dark) .clear-btn:hover {
      color: #d1d5db;
      background: rgba(255, 255, 255, 0.1);
    }
  `]
})
export class StepSearchComponent {
  @ViewChild('searchInput') searchInputRef!: ElementRef<HTMLInputElement>;
  @Output() filterChange = new EventEmitter<string>();

  searchQuery = signal('');

  onSearchInput(value: string): void {
    this.searchQuery.set(value);
    this.filterChange.emit(value);
  }

  clearSearch(): void {
    this.searchQuery.set('');
    this.filterChange.emit('');
    this.searchInputRef?.nativeElement?.focus();
  }
}
