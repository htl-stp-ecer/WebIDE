import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RoutePreview } from './route-preview';

describe('RoutePreview', () => {
  let component: RoutePreview;
  let fixture: ComponentFixture<RoutePreview>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RoutePreview]
    })
    .compileComponents();

    fixture = TestBed.createComponent(RoutePreview);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
