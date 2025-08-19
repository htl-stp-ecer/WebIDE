import { Component, Input } from '@angular/core';
import { HttpService } from '../../services/http-service';

@Component({
  selector: 'app-step-panel',
  templateUrl: './step-panel.html',
  styleUrls: ['./step-panel.scss']
})
export class StepPanel {
  steps: Step[] = [];

  @Input() ip: string = "";

  constructor(private http: HttpService) {
    this.http.getAllSteps(this.ip).subscribe(steps => this.steps = steps);

  }


}
