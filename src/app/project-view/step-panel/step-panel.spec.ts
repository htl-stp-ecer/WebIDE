import { ComponentFixture, TestBed } from '@angular/core/testing';

import { StepPanel } from './step-panel';

describe('StepPanel', () => {
  let component: StepPanel;
  let fixture: ComponentFixture<StepPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StepPanel]
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
