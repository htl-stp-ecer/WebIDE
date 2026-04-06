import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';

const SUB_CATEGORY_THRESHOLD = 3;

interface CategoryEntry {
  name: string;
  count: number;
}

/** A row in the detail panel — either a drillable subcategory or a selectable step. */
interface DetailRow {
  type: 'subcategory' | 'step';
  label: string;
  count?: number;
  step?: Step;
  subTag?: string;
}

@Component({
  selector: 'app-step-picker-modal',
  standalone: true,
  imports: [FormsModule, TranslateModule],
  template: `
    @if (visible) {
      <div class="step-picker-backdrop" (pointerdown)="close()"></div>
      <div class="step-picker" [style.left.px]="posX" [style.top.px]="posY"
           (pointerdown)="$event.stopPropagation()">

        <div class="step-picker-header">
          @if (breadcrumb().length) {
            <button class="back-btn" (click)="goBack()">
              <i class="pi pi-arrow-left"></i>
            </button>
            <span class="header-title">{{ breadcrumb()[breadcrumb().length - 1] }}</span>
          } @else {
            <span class="header-title">{{ 'FLOWCHART.INSERT_STEP' | translate }}</span>
          }
        </div>

        <div class="step-picker-search">
          <i class="pi pi-search search-icon"></i>
          <input
            #searchInput
            type="text"
            class="search-input"
            [placeholder]="'Search...'"
            [(ngModel)]="searchText"
            (input)="onSearch()"
            (keydown.escape)="searchText ? clearSearch() : close()"
            (keydown.enter)="selectFirst()"
          />
          @if (searchText) {
            <button class="search-clear" (click)="clearSearch()">
              <i class="pi pi-times"></i>
            </button>
          }
        </div>

        <div class="step-picker-body-clip">
          <div class="step-picker-body" [class.slide-left]="breadcrumb().length > 0">
            <!-- Left panel: top-level categories OR search results -->
            <div class="step-picker-panel">
              @if (searchText) {
                @for (step of filteredSteps(); track step.name + step.file) {
                  <button class="step-item" (click)="selectStep(step)">
                    <span class="step-name">{{ step.name }}</span>
                    <span class="step-tag">{{ getStepTag(step) }}</span>
                  </button>
                } @empty {
                  <div class="empty-state">No matching steps</div>
                }
              } @else {
                @for (cat of topCategories(); track cat.name) {
                  <button class="category-item" (click)="openCategory(cat.name)">
                    <span class="category-name">{{ cat.name }}</span>
                    <span class="category-count">{{ cat.count }}</span>
                    <i class="pi pi-chevron-right category-arrow"></i>
                  </button>
                }
              }
            </div>

            <!-- Right panel: detail rows (subcategories + steps, or just steps) -->
            <div class="step-picker-panel">
              @for (row of detailRows(); track row.label + row.type) {
                @if (row.type === 'subcategory') {
                  <button class="category-item" (click)="openSubCategory(row.subTag!)">
                    <span class="category-name">{{ row.label }}</span>
                    <span class="category-count">{{ row.count }}</span>
                    <i class="pi pi-chevron-right category-arrow"></i>
                  </button>
                } @else {
                  <button class="step-item" (click)="selectStep(row.step!)">
                    <span class="step-name">{{ row.label }}</span>
                  </button>
                }
              } @empty {
                <div class="empty-state">No steps</div>
              }
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styleUrl: './step-picker-modal.scss',
})
export class StepPickerModal implements OnChanges, OnDestroy {
  @Input() visible = false;
  @Input() posX = 0;
  @Input() posY = 0;
  @Input() steps: Step[] = [];
  @Output() stepSelected = new EventEmitter<Step>();
  @Output() closed = new EventEmitter<void>();
  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;

  searchText = '';

  /** Navigation stack: e.g. [] → ["motion"] → ["motion", "drive"] */
  readonly breadcrumb = signal<string[]>([]);
  readonly topCategories = signal<CategoryEntry[]>([]);
  readonly detailRows = signal<DetailRow[]>([]);
  readonly filteredSteps = signal<Step[]>([]);

  private escListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.visible) this.close();
  };

  // ---------- lifecycle ----------

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['steps'] || changes['visible']) {
      this.rebuildTopCategories();
    }
    if (changes['visible'] && this.visible) {
      this.searchText = '';
      this.breadcrumb.set([]);
      this.detailRows.set([]);
      this.filteredSteps.set([]);
      this.clampPosition();
      setTimeout(() => this.searchInput?.nativeElement.focus(), 0);
      document.addEventListener('keydown', this.escListener);
    }
    if (changes['visible'] && !this.visible) {
      document.removeEventListener('keydown', this.escListener);
    }
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.escListener);
  }

  // ---------- build top categories ----------

  private rebuildTopCategories(): void {
    const tagCounts: Record<string, number> = {};
    for (const step of this.steps) {
      const tags = this.validTags(step);
      if (!tags.length) {
        tagCounts['Other'] = (tagCounts['Other'] ?? 0) + 1;
      } else {
        for (const t of tags) {
          tagCounts[t] = (tagCounts[t] ?? 0) + 1;
        }
      }
    }
    this.topCategories.set(
      Object.entries(tagCounts)
        .sort(([a], [b]) => {
          if (a === 'Other') return 1;
          if (b === 'Other') return -1;
          return a.localeCompare(b);
        })
        .map(([name, count]) => ({ name, count }))
    );
  }

  // ---------- navigation ----------

  openCategory(name: string): void {
    this.breadcrumb.set([name]);
    this.rebuildDetail();
  }

  openSubCategory(subTag: string): void {
    this.breadcrumb.update(bc => [...bc, subTag]);
    this.rebuildDetail();
  }

  goBack(): void {
    const bc = this.breadcrumb();
    if (bc.length <= 1) {
      this.breadcrumb.set([]);
      this.detailRows.set([]);
    } else {
      this.breadcrumb.set(bc.slice(0, -1));
      this.rebuildDetail();
    }
  }

  // ---------- build detail rows ----------

  private rebuildDetail(): void {
    const bc = this.breadcrumb();
    if (!bc.length) { this.detailRows.set([]); return; }

    // Steps that have ALL breadcrumb tags
    const matching = this.steps.filter(s => {
      const tags = this.validTags(s);
      if (!tags.length && bc.length === 1 && bc[0] === 'Other') return true;
      return bc.every(t => tags.includes(t));
    });

    // Remaining tags (not in breadcrumb) — potential subcategories
    const subTagCounts: Record<string, Step[]> = {};
    for (const step of matching) {
      const remaining = this.validTags(step).filter(t => !bc.includes(t));
      for (const t of remaining) {
        (subTagCounts[t] ??= []).push(step);
      }
    }

    // Filter subcategories:
    //  - need ≥3 steps
    //  - must actually narrow (not contain ALL steps at this level)
    const subCats = Object.entries(subTagCounts)
      .filter(([, steps]) =>
        steps.length >= SUB_CATEGORY_THRESHOLD &&
        steps.length < matching.length
      )
      .sort(([a], [b]) => a.localeCompare(b));

    const stepsInSubCats = new Set<Step>();
    for (const [, steps] of subCats) {
      for (const s of steps) stepsInSubCats.add(s);
    }

    // Loose steps — not in any qualifying subcategory
    const loose = matching
      .filter(s => !stepsInSubCats.has(s))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Auto-flatten: if exactly 1 subcategory and 0 loose steps, drill into it
    if (subCats.length === 1 && loose.length === 0) {
      this.breadcrumb.update(b => [...b, subCats[0][0]]);
      this.rebuildDetail();
      return;
    }

    // If no subcategories survived, just show all steps flat
    if (subCats.length === 0) {
      this.detailRows.set(
        matching
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(step => ({ type: 'step' as const, label: step.name, step }))
      );
      return;
    }

    const rows: DetailRow[] = [];
    for (const [tag, steps] of subCats) {
      rows.push({ type: 'subcategory', label: tag, count: steps.length, subTag: tag });
    }
    for (const step of loose) {
      rows.push({ type: 'step', label: step.name, step });
    }
    this.detailRows.set(rows);
  }

  // ---------- search ----------

  onSearch(): void {
    const q = this.searchText.toLowerCase().trim();
    if (!q) {
      this.filteredSteps.set([]);
      return;
    }
    this.breadcrumb.set([]);
    this.filteredSteps.set(
      this.steps
        .filter(s => s.name.toLowerCase().includes(q))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  }

  clearSearch(): void {
    this.searchText = '';
    this.filteredSteps.set([]);
    this.searchInput?.nativeElement.focus();
  }

  selectFirst(): void {
    if (this.searchText) {
      const list = this.filteredSteps();
      if (list.length) this.selectStep(list[0]);
    } else {
      const rows = this.detailRows();
      const first = rows.find(r => r.type === 'step');
      if (first?.step) this.selectStep(first.step);
    }
  }

  // ---------- actions ----------

  selectStep(step: Step): void {
    this.stepSelected.emit(step);
    this.close();
  }

  close(): void {
    this.closed.emit();
  }

  // ---------- helpers ----------

  getStepTag(step: Step): string {
    return step.tags?.find(t => t?.trim()) ?? '';
  }

  private validTags(step: Step): string[] {
    return step.tags?.filter(t => typeof t === 'string' && t.trim() !== '') ?? [];
  }

  private clampPosition(): void {
    const margin = 8;
    const w = 260;
    const h = 360;
    if (this.posX + w > window.innerWidth - margin) {
      this.posX = window.innerWidth - w - margin;
    }
    if (this.posY + h > window.innerHeight - margin) {
      this.posY = window.innerHeight - h - margin;
    }
    if (this.posX < margin) this.posX = margin;
    if (this.posY < margin) this.posY = margin;
  }
}
