import { Component, OnInit } from '@angular/core';
import { FExternalItemDirective } from '@foblex/flow';
import { HttpService } from '../../services/http-service';
import { StepsStateService } from '../../services/steps-state-service';
import {ActivatedRoute} from '@angular/router';

interface StepGroup {
  headline: string;
  steps: Step[];
}

@Component({
  selector: 'app-step-panel',
  templateUrl: './step-panel.html',
  imports: [
    FExternalItemDirective,
  ],
  styleUrls: ['./step-panel.scss']
})
export class StepPanel implements OnInit {
  stepGroups: StepGroup[] = [];

  constructor(private http: HttpService, private stepStateService: StepsStateService, private route: ActivatedRoute) {}

  ngOnInit(): void {
    this.http.getAllSteps(this.route.snapshot.paramMap.get('uuid')!).subscribe(steps => {
      this.stepStateService.setSteps(steps);
      this.groupSteps(steps);
    });
  }

  private groupSteps(steps: Step[]): void {
    const prefixCounts: Record<string, number> = {};
    const suffixCounts: Record<string, number> = {};

    // 1) Build frequency maps for prefixes and suffixes
    for (const step of steps) {
      const parts = step.name.split('_');
      if (parts.length > 1) {
        const pref = parts[0];
        const suff = parts[parts.length - 1];
        prefixCounts[pref] = (prefixCounts[pref] ?? 0) + 1;
        suffixCounts[suff] = (suffixCounts[suff] ?? 0) + 1;
      }
    }

    // 2) Assign each step to the best dynamic key
    const groups: Record<string, Step[]> = {};
    for (const step of steps) {
      const parts = step.name.split('_');

      let key: string;
      if (parts.length > 1) {
        const pref = parts[0];
        const suff = parts[parts.length - 1];
        const prefCount = prefixCounts[pref] ?? 0;
        const suffCount = suffixCounts[suff] ?? 0;

        if (suffCount > 1 && suffCount >= prefCount) {
          key = suff;           // e.g., *_servo → "servo"
        } else if (prefCount > 1) {
          key = pref;           // e.g., strafe_* → "strafe"
        } else {
          key = step.name;      // no real family — keep its own group
        }
      } else {
        key = step.name;        // single word → its own group
      }

      (groups[key] ??= []).push(step);
    }

    // 3) Normalize output (optional: sort headlines and steps)
    this.stepGroups = Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([headline, groupedSteps]) => ({
        headline,
        steps: groupedSteps.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }

}
