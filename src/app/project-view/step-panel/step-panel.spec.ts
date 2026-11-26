import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { appConfig } from '../../app.config';
import { StepPanel } from './step-panel';

describe('StepPanel', () => {
  let component: StepPanel;
  let fixture: ComponentFixture<StepPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StepPanel],
      providers: [...appConfig.providers, provideHttpClientTesting()]
    })
    .compileComponents();

    fixture = TestBed.createComponent(StepPanel);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
