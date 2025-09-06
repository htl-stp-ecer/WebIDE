import {Component} from '@angular/core';
import {MissionPanel} from './mission-panel/mission-panel';
import {Flowchart} from './flowchart/flowchart';
import {StepPanel} from './step-panel/step-panel';

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
  ) {}

}
