import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { appConfig } from '../app.config';
import { ProjectView } from './project-view';

describe('ProjectView', () => {
  let component: ProjectView;
  let fixture: ComponentFixture<ProjectView>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProjectView],
      providers: [...appConfig.providers, provideHttpClientTesting()]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ProjectView);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
