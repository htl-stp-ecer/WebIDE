import {Component, OnInit} from '@angular/core';
import {FExternalItemDirective} from '@foblex/flow';
import {HttpService} from '../../services/http-service';

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

  constructor(private http: HttpService) {

  }

  ngOnInit(): void {
    this.http.getAllSteps().subscribe(steps => {
      this.steps = steps
    });
  }


}
