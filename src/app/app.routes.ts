import { Routes } from '@angular/router';
import {Home} from './home/home';
import {ProjectMenu} from './project-menu/project-menu';
import {ProjectView} from './project-view/project-view';

export const routes: Routes = [
  {path: ":ip/projects", component: ProjectMenu},
  {path: ":ip/projects/:uuid", component: ProjectView},
  {path: "**", component: Home}
];
