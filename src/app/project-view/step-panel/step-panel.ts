import {Component, OnInit} from '@angular/core';
import {FExternalItemDirective} from '@foblex/flow';
import {HttpService} from '../../services/http-service';
import {StepsStateService} from '../../services/steps-state-service';

@Component({
  selector: 'app-step-panel',
  templateUrl: './step-panel.html',
  imports: [
    FExternalItemDirective,
  ],
  styleUrls: ['./step-panel.scss']
})
export class StepPanel implements OnInit {
  steps: Step[] = [];

  constructor(private http: HttpService, private stepStateService: StepsStateService) {

  }

  ngOnInit(): void {
    this.http.getAllSteps().subscribe(steps => {
      this.steps = steps;
      this.addDefaultSteps();
      this.stepStateService.setSteps(this.steps);
    });
  }

  private addDefaultSteps(): void {
    this.steps.push({
      name: 'sequential',
      import: 'from libstp_helpers.api.steps import seq',
      arguments: [],
      file: ''
    });

    this.steps.push({
      name: 'parallel',
      import: '',
      arguments: [],
      file: ''
    });

    this.steps.push({
      name: 'timeout',
      import: '',
      arguments: [
        {
          name: 'timeout',
          type: 'float',
          import: null,
          optional: false,
          default: null
        }
      ],
      file: ''
    });
  }
}
