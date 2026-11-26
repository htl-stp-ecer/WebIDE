import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { appConfig } from '../../app.config';
import { Flowchart } from './flowchart';

describe('Flowchart', () => {
  let component: Flowchart;
  let fixture: ComponentFixture<Flowchart>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Flowchart],
      providers: [...appConfig.providers, provideHttpClientTesting()]
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
