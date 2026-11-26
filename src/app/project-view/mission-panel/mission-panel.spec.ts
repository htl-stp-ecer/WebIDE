import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { appConfig } from '../../app.config';
import { MissionPanel } from './mission-panel';

describe('MissionPanel', () => {
  let component: MissionPanel;
  let fixture: ComponentFixture<MissionPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MissionPanel],
      providers: [...appConfig.providers, provideHttpClientTesting()]
    })
    .compileComponents();

    fixture = TestBed.createComponent(MissionPanel);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
