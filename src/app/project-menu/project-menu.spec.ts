import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ProjectMenu } from './project-menu';

describe('ProjectMenu', () => {
  let component: ProjectMenu;
  let fixture: ComponentFixture<ProjectMenu>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProjectMenu]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ProjectMenu);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
