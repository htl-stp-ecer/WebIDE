import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError, BehaviorSubject } from 'rxjs';

import { Navbar } from './navbar';
import { HttpService } from '../services/http-service';
import { TranslateModule } from '@ngx-translate/core';

describe('Navbar UI behavior', () => {
  let component: Navbar;
  let fixture: ComponentFixture<Navbar>;
  let deviceBase$: BehaviorSubject<string>;
  let getDeviceInfoDefault: jasmine.Spy;

  beforeEach(async () => {
    deviceBase$ = new BehaviorSubject<string>('');
    getDeviceInfoDefault = jasmine.createSpy('getDeviceInfoDefault').and.returnValue(of({
      hostname: 'raccoon',
      battery_voltage_v: 7.42,
      battery_percent: 81,
      ip: 'http://127.0.0.1:8000',
    }));
    await TestBed.configureTestingModule({
      imports: [Navbar, TranslateModule.forRoot()],
      providers: [
        provideRouter([]),
        { provide: HttpService, useValue: { deviceBase$, getDeviceInfoDefault } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Navbar);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('shows the battery voltage when device info is available', () => {
    deviceBase$.next('http://127.0.0.1:8000');
    fixture.detectChanges();

    const battery = fixture.nativeElement.querySelector('.device-battery');
    expect(battery.textContent.replace(/\s+/g, '')).toBe('7.4V');
    expect(component.deviceInfoLoading).toBeFalse();
  });

  it('hides the battery when the device info request fails', () => {
    getDeviceInfoDefault.and.returnValue(throwError(() => new Error('offline')));

    deviceBase$.next('http://127.0.0.1:8000');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.device-battery')).toBeNull();
    expect(component.deviceInfoLoading).toBeFalse();
  });

});
