import { Routes } from '@angular/router';
import {ProjectMenu} from './project-menu/project-menu';

export const routes: Routes = [
  {path: "**", component: ProjectMenu}
];
