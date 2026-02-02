import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import { FExternalItemDirective } from '@foblex/flow';
import { HttpService } from '../../services/http-service';
import { StepsStateService } from '../../services/steps-state-service';
import { ActivatedRoute } from '@angular/router';
import { Skeleton } from 'primeng/skeleton';
import { Subscription } from 'rxjs';
import { NgClass } from '@angular/common';
import { StepSearchComponent } from './step-search/step-search';

interface StepGroup {
  headline: string;
  steps: Step[];
  collapsed: boolean;
}

@Component({
  selector: 'app-step-panel',
  templateUrl: './step-panel.html',
  imports: [
    FExternalItemDirective,
    Skeleton,
    NgClass,
    StepSearchComponent,
  ],
  styleUrls: ['./step-panel.scss']
})
export class StepPanel implements OnInit, OnDestroy {
  stepGroups: StepGroup[] = [];
  filteredStepGroups: StepGroup[] = [];
  stepsLoading = true;
  searchFilter = '';

  /** Track collapsed state by group headline */
  private collapsedState = signal<Record<string, boolean>>({});

  private refreshSub?: Subscription;
  private projectUUID: string | null = null;

  constructor(
    private http: HttpService,
    private stepStateService: StepsStateService,
    private route: ActivatedRoute
  ) {}

  ngOnInit(): void {
    this.projectUUID = this.route.snapshot.paramMap.get('uuid');
    this.loadSteps();

    // Listen for refresh events from settings modal
    this.refreshSub = this.stepStateService.refresh$.subscribe(() => {
      this.loadSteps();
    });
  }

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
  }

  private loadSteps(): void {
    if (!this.projectUUID) {
      this.stepGroups = [];
      this.stepsLoading = false;
      return;
    }
    this.stepsLoading = true;
    this.http.getAllSteps(this.projectUUID).subscribe({
      next: steps => {
        this.stepStateService.setSteps(steps);
        this.groupSteps(steps);
        this.stepsLoading = false;
      },
      error: () => {
        this.stepGroups = [];
        this.stepStateService.setSteps([]);
        this.stepsLoading = false;
      },
    });
  }

  clearSelection(): void {
    const selection = window.getSelection();
    if (selection && selection.type !== 'None') {
      selection.removeAllRanges();
    }
  }

  toggleGroup(group: StepGroup): void {
    group.collapsed = !group.collapsed;
    // Persist collapsed state
    const state = { ...this.collapsedState() };
    state[group.headline] = group.collapsed;
    this.collapsedState.set(state);
  }

  onFilterChange(filter: string): void {
    this.searchFilter = filter.toLowerCase().trim();
    if (!this.searchFilter) {
      this.filteredStepGroups = this.stepGroups;
      return;
    }
    this.filteredStepGroups = this.stepGroups
      .map(group => ({
        headline: group.headline,
        collapsed: group.collapsed,
        steps: group.steps.filter(step =>
          step.name.toLowerCase().includes(this.searchFilter)
        ),
      }))
      .filter(group => group.steps.length > 0);
  }

  private groupSteps(steps: Step[]): void {
    const groups: Record<string, Step[]> = {};
    const UNGROUPED_KEY = 'Other';

    for (const step of steps) {
      // Use tags as primary grouping mechanism
      const tags = step.tags?.filter(tag => typeof tag === 'string' && tag.trim() !== '') ?? [];

      let key: string;
      if (tags.length > 0) {
        // Use first tag as group key
        key = tags[0];
      } else {
        // No tags - put in "Other" group
        key = UNGROUPED_KEY;
      }

      (groups[key] ??= []).push(step);
    }

    // Restore collapsed state and sort
    const savedState = this.collapsedState();

    this.stepGroups = Object.entries(groups)
      .sort(([a], [b]) => {
        // "Other" always goes last
        if (a === UNGROUPED_KEY) return 1;
        if (b === UNGROUPED_KEY) return -1;
        return a.localeCompare(b);
      })
      .map(([headline, groupedSteps]) => ({
        headline,
        steps: groupedSteps.sort((a, b) => a.name.localeCompare(b.name)),
        collapsed: savedState[headline] ?? false,
      }));
    this.onFilterChange(this.searchFilter);
  }
}
