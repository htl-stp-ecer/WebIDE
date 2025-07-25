import { Component } from '@angular/core';
import {InputGroup} from 'primeng/inputgroup';
import {InputText} from 'primeng/inputtext';
import {Button} from 'primeng/button';

@Component({
  selector: 'app-home',
  imports: [
    InputGroup,
    InputText,
    Button
  ],
  templateUrl: './home.html',
  styleUrl: './home.scss'
})
export class Home {

}
