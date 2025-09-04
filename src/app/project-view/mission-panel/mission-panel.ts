import {Component, OnInit} from '@angular/core';
import {ActivatedRoute} from '@angular/router';

@Component({
  selector: 'app-mission-panel',
  imports: [],
  templateUrl: './mission-panel.html',
  styleUrl: './mission-panel.scss'
})
export class MissionPanel implements OnInit{
  projectUUID: string | null = "";

  constructor(private route: ActivatedRoute) {
  }

  ngOnInit(): void {
    this.projectUUID = this.route.snapshot.paramMap.get('uuid');
  }



}
