import {Component, Input, OnInit} from '@angular/core';
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

  @Input() ip: string = "";

  constructor(private http: HttpService) {

  }

  ngOnInit(): void {
    this.http.getAllSteps(this.ip).subscribe(steps => {
      this.steps = steps
    });
  }


}
