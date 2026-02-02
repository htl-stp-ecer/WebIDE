import { Routes } from '@angular/router';
import {Home} from './home/home';
import {ProjectMenu} from './project-menu/project-menu';
import {LocalProjects} from './local-projects/local-projects';
import {ProjectView} from './project-view/project-view';

export const routes: Routes = [
  {path: "projects", component: LocalProjects},
  {path: "projects/:uuid", component: ProjectView},
  {path: "device/:ip/projects", component: ProjectMenu},
  {path: "", component: Home},
  {path: "**", component: Home}
];
