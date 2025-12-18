import {Component} from '@angular/core';
import {MissionPanel} from './mission-panel/mission-panel';
import {Flowchart} from './flowchart/flowchart';
import {StepPanel} from './step-panel/step-panel';
import { ActivatedRoute } from '@angular/router';
import { HttpService } from '../services/http-service';
import { decodeRouteIp } from '../services/route-ip-serializer';

@Component({
  selector: 'app-project-view',
  imports: [
    MissionPanel,
    Flowchart,
    StepPanel
  ],
  templateUrl: './project-view.html',
  styleUrl: './project-view.scss'
})
export class ProjectView {
  constructor(
    private route: ActivatedRoute,
    private http: HttpService,
  ) {
    const ipParam = this.route.snapshot.paramMap.get('ip');
    const decodedIp = decodeRouteIp(ipParam);
    if (decodedIp) {
      this.http.setIp(decodedIp);
    }
  }
}
