import { Routes } from '@angular/router';
import {Home} from './home/home';
import {ProjectMenu} from './project-menu/project-menu';
import {ProjectView} from './project-view/project-view';
import {PathPlannerPage} from './project-view/flowchart/table/planning/path-planner-page.component';

export const routes: Routes = [
  {path: ":ip/projects", component: ProjectMenu},
  {path: ":ip/projects/:uuid", component: ProjectView},
  {path: ":ip/projects/:uuid/path-planner", component: PathPlannerPage},
  {path: "**", component: Home}
];
