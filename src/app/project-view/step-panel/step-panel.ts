import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FExternalItemDirective } from '@foblex/flow';
import { StepsStateService } from '../../services/steps-state-service';
import { Skeleton } from '@openng/optimus-ui/skeleton';
import { NgClass } from '@angular/common';
import { StepSearchComponent } from './step-search/step-search';

interface StepGroup {
  headline: string;
  steps: Step[];
  collapsed: boolean;
}

const UNGROUPED_KEY = 'Other';

@Component({
  selector: 'app-step-panel',
  templateUrl: './step-panel.html',
  imports: [
    FExternalItemDirective,
    Skeleton,
    NgClass,
    StepSearchComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./step-panel.scss']
})
export class StepPanel {
  private readonly stepState = inject(StepsStateService);
  private readonly collapsedState = signal<Record<string, boolean>>({});

  readonly searchFilter = signal('');
  readonly stepsLoading = this.stepState.isLoading;
  readonly hasLoadError = this.stepState.hasLoadError;
  readonly filteredStepGroups = computed(() => {
    const groups = new Map<string, Step[]>();
    const filter = this.searchFilter();

    for (const step of this.stepState.currentSteps() ?? []) {
      if (!step.name.toLowerCase().includes(filter)) continue;
      const headline = step.tags?.find(tag => typeof tag === 'string' && tag.trim() !== '') ?? UNGROUPED_KEY;
      const group = groups.get(headline);
      if (group) group.push(step);
      else groups.set(headline, [step]);
    }

    const savedState = this.collapsedState();
    return [...groups.entries()]
      .sort(([a], [b]) => {
        if (a === UNGROUPED_KEY) return 1;
        if (b === UNGROUPED_KEY) return -1;
        return a.localeCompare(b);
      })
      .map(([headline, steps]) => ({
        headline,
        steps: steps.sort((a, b) => a.name.localeCompare(b.name)),
        collapsed: savedState[headline] ?? false,
      }));
  });

  clearSelection(): void {
    const selection = window.getSelection();
    if (selection && selection.type !== 'None') {
      selection.removeAllRanges();
    }
  }

  toggleGroup(group: StepGroup): void {
    this.collapsedState.update(state => ({ ...state, [group.headline]: !group.collapsed }));
  }

  onFilterChange(filter: string): void {
    this.searchFilter.set(filter.toLowerCase().trim());
  }
}
