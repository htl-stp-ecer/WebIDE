import { Routes } from '@angular/router';
import {Home} from './home/home';
import {ProjectMenu} from './project-menu/project-menu';

export const routes: Routes = [
  {path: ":ip/projects", component: ProjectMenu},
  {path: "**", component: Home}
];
