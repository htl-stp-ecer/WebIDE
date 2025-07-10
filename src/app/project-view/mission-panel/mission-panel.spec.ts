import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MissionPanel } from './mission-panel';

describe('MissionPanel', () => {
  let component: MissionPanel;
  let fixture: ComponentFixture<MissionPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MissionPanel]
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
