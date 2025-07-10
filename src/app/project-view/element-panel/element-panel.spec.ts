import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ElementPanel } from './element-panel';

describe('ElementPanel', () => {
  let component: ElementPanel;
  let fixture: ComponentFixture<ElementPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ElementPanel]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ElementPanel);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
