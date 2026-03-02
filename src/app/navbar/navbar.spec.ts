import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError, BehaviorSubject } from 'rxjs';

import { Navbar } from './navbar';
import { HttpService } from '../services/http-service';
import { TranslateService } from '@ngx-translate/core';

class MockTranslateService {
  setTranslation() {}
  addLangs() {}
  setDefaultLang() {}
  use() {}
}

describe('Navbar UI behavior', () => {
  let component: Navbar;
  let fixture: ComponentFixture<Navbar>;
  const deviceBase$ = new BehaviorSubject<string>('');

  const httpMock = {
    deviceBase$,
    getDeviceInfoDefault: jasmine.createSpy('getDeviceInfoDefault').and.returnValue(of({
      hostname: 'raccoon',
      battery_voltage_v: 7.42,
      battery_percent: 81,
      ip: 'http://127.0.0.1:8000',
    })),
  } as unknown as HttpService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Navbar],
      providers: [
        provideRouter([]),
        { provide: HttpService, useValue: httpMock },
        { provide: TranslateService, useClass: MockTranslateService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Navbar);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('shows online status and voltage when device info is available', () => {
    deviceBase$.next('http://127.0.0.1:8000');
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('COMMON.ONLINE');
    expect(text).toContain('7.42 V');
    expect(component.deviceInfoLoading).toBeFalse();
  });

  it('shows offline status when info request fails', () => {
    (httpMock.getDeviceInfoDefault as jasmine.Spy).and.returnValue(throwError(() => new Error('offline')));

    deviceBase$.next('http://127.0.0.1:8000');
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('COMMON.OFFLINE');
    expect(component.deviceInfoLoading).toBeFalse();
  });

  it('toggles dark mode class on html element', () => {
    const html = document.querySelector('html')!;
    html.classList.remove('dark');

    component.toggleDarkMode();
    expect(html.classList.contains('dark')).toBeTrue();

    component.toggleDarkMode();
    expect(html.classList.contains('dark')).toBeFalse();
  });
});
