import {Component, OnInit} from '@angular/core';
import {ActivatedRoute} from '@angular/router';

@Component({
  selector: 'app-project-menu',
  imports: [],
  templateUrl: './project-menu.html',
  styleUrl: './project-menu.scss'
})
export class ProjectMenu implements OnInit {
  ip: string | null = null;

  constructor(private route: ActivatedRoute) {}

  ngOnInit() {
    this.ip = this.route.snapshot.paramMap.get('ip');
    // console.log('Prefix:', this.ip);
  }
}
