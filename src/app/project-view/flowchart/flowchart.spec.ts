import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Flowchart } from './flowchart';

describe('Flowchart', () => {
  let component: Flowchart;
  let fixture: ComponentFixture<Flowchart>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Flowchart]
    })
    .compileComponents();

    fixture = TestBed.createComponent(Flowchart);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
