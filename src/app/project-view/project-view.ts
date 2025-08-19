import {Component, OnInit} from '@angular/core';
import {ActivatedRoute} from '@angular/router';
import {Card} from 'primeng/card';

@Component({
  selector: 'app-project-view',
  imports: [
    Card
  ],
  templateUrl: './project-view.html',
  styleUrl: './project-view.scss'
})
export class ProjectView implements OnInit {

  ip: string | null = "";
  uuid: string | null = "";


  constructor(
    private route: ActivatedRoute,
  ) {}

  ngOnInit() {
    this.ip = this.route.snapshot.paramMap.get('ip');
    this.uuid = this.route.snapshot.paramMap.get('uuid');
  }

}
