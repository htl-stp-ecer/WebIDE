import { Injectable, OnDestroy, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { configureStepTagCatalog } from '../project-view/flowchart/table/step-id';
import { HttpService } from './http-service';

@Injectable({ providedIn: 'root' })
export class StepsStateService implements OnDestroy {
  private readonly steps = signal<Step[] | null>(null);
  private readonly loading = signal(false);
  private readonly loadFailed = signal(false);

  readonly currentSteps = this.steps.asReadonly();
  readonly isLoading = this.loading.asReadonly();
  readonly hasLoadError = this.loadFailed.asReadonly();

  private projectUuid: string | null = null;
  private request?: Subscription;

  constructor(private readonly http: HttpService) {}

  setProject(projectUuid: string | null): void {
    if (projectUuid === this.projectUuid) return;
    this.request?.unsubscribe();
    this.projectUuid = projectUuid;
    this.setSteps(null);
    this.loading.set(false);
    this.loadFailed.set(false);
    this.triggerRefresh();
  }

  triggerRefresh(projectUuid = this.projectUuid): void {
    if (!projectUuid || projectUuid !== this.projectUuid) return;
    this.request?.unsubscribe();
    this.loading.set(true);
    this.loadFailed.set(false);
    this.request = this.http.getAllSteps(projectUuid).subscribe({
      next: steps => {
        this.setSteps(steps);
        this.loading.set(false);
      },
      error: () => {
        this.setSteps([]);
        this.loadFailed.set(true);
        this.loading.set(false);
      },
    });
  }

  ngOnDestroy(): void {
    this.projectUuid = null;
    this.request?.unsubscribe();
  }

  private setSteps(steps: Step[] | null): void {
    configureStepTagCatalog(steps);
    this.steps.set(steps);
  }
}
