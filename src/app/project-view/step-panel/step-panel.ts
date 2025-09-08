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
      this.steps = steps
      this.stepStateService.setSteps(steps)
    });
  }


}
