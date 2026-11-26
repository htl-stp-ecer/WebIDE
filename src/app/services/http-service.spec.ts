import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { HttpService } from './http-service';

const WOMBAT = 'http://wombat.test:8421/api/v1/device';
const DEVICE = {
  hostname: 'wombat',
  ip: '192.0.2.1',
  width_cm: 24,
  length_cm: 40,
  sensors: [
    { name: 'front', x_pct: 0, y_pct: 25, clearance_cm: 3 },
    { name: 'rear', x_pct: 100, y_pct: 100, clearance_cm: null },
    { name: 'unplaced', x_pct: null, y_pct: null },
  ],
  rotation_center: { x_pct: 25, y_pct: 75 },
  start_pose: { x_cm: 20, y_cm: 30, theta_deg: 90 },
};

describe('HttpService device coordinates', () => {
  let service: HttpService;
  let http: HttpTestingController;
  let savedPort: string | null;
  let savedToken: string | null;

  beforeEach(() => {
    savedPort = localStorage.getItem('localBackendPort');
    savedToken = localStorage.getItem('raccoon_device_token');
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(HttpService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    restoreStorage('localBackendPort', savedPort);
    restoreStorage('raccoon_device_token', savedToken);
  });

  function connect(): void {
    service.setDeviceBase('http://wombat.test:8421');
    http.expectOne({ method: 'GET', url: `${WOMBAT}/token` }).flush({ token: 'fixture-token' });
  }

  it('converts percentage reads to centimeters from the back-left and keeps the metric start pose', () => {
    let info: ConnectionInfo | undefined;
    service.getDeviceInfo('http://wombat.test:8421').subscribe(result => info = result);
    http.expectOne({ method: 'GET', url: `${WOMBAT}/info` }).flush(DEVICE);

    expect(info?.sensors).toEqual([
      { name: 'front', x_cm: 0, y_cm: 30, clearance_cm: 3 },
      { name: 'rear', x_cm: 24, y_cm: 0, clearance_cm: undefined },
      { name: 'unplaced', x_cm: undefined, y_cm: undefined, clearance_cm: undefined },
    ]);
    expect(info?.rotation_center).toEqual({ x_cm: 6, y_cm: 10 });
    expect(info?.start_pose).toEqual(DEVICE.start_pose);
  });

  it('uses the available axes and leaves coordinates with missing dimensions unset', () => {
    connect();
    let info: ConnectionInfo | undefined;
    service.getDeviceInfoDefault().subscribe(result => info = result);
    http.expectOne({ method: 'GET', url: `${WOMBAT}/info` }).flush({ ...DEVICE, width_cm: null });

    expect(info?.sensors?.[0]?.x_cm).toBeUndefined();
    expect(info?.sensors?.[0]?.y_cm).toBe(30);
    expect(info?.rotation_center).toBeUndefined();
  });

  it('converts sensor writes using the dimensions of the selected Wombat', () => {
    connect();
    let info: ConnectionInfo | undefined;
    service.updateDeviceSensors([
      { name: 'front', x_cm: 0, y_cm: 30, clearance_cm: 3 },
      { name: 'unplaced' },
    ]).subscribe(result => info = result);
    http.expectOne({ method: 'GET', url: `${WOMBAT}/info` }).flush(DEVICE);

    const put = http.expectOne({ method: 'PUT', url: `${WOMBAT}/sensors` });
    expect(JSON.parse(put.request.serializeBody() as string)).toEqual({
      sensors: [{ name: 'front', x_pct: 0, y_pct: 25, clearance_cm: 3 }, { name: 'unplaced' }],
    });
    put.flush(DEVICE);
    expect(info?.sensors?.[0]).toEqual({ name: 'front', x_cm: 0, y_cm: 30, clearance_cm: 3 });
  });

  it('rejects a sensor position write when conversion lacks a dimension', () => {
    connect();
    const result = jasmine.createSpy('error');
    service.updateDeviceSensors([{ name: 'front', x_cm: 8 }]).subscribe({ error: result });
    http.expectOne({ method: 'GET', url: `${WOMBAT}/info` }).flush({ ...DEVICE, width_cm: null });
    http.expectNone({ method: 'PUT', url: `${WOMBAT}/sensors` });
    expect(result).toHaveBeenCalledOnceWith(jasmine.any(Error));
  });

  it('sets or clears a rotation center using the Wombat percentage contract', () => {
    connect();
    service.updateDeviceRotationCenter({ x_cm: 6, y_cm: 10 }).subscribe();
    http.expectOne({ method: 'GET', url: `${WOMBAT}/info` }).flush(DEVICE);
    const set = http.expectOne({ method: 'PUT', url: `${WOMBAT}/rotation-center` });
    expect(set.request.body).toEqual({ rotation_center: { x_pct: 25, y_pct: 75 } });
    set.flush(DEVICE);

    service.updateDeviceRotationCenter().subscribe(info => expect(info.rotation_center).toBeUndefined());
    const clear = http.expectOne({ method: 'PUT', url: `${WOMBAT}/rotation-center` });
    expect(clear.request.body).toEqual({ rotation_center: null });
    clear.flush({ ...DEVICE, rotation_center: null });
  });

  it('preserves centimeter reads and writes on the local IDE API', () => {
    service.setLocalBackendPort('8765');
    const local = new URL(window.location.origin);
    local.port = '8765';
    const base = `${local.origin}/api/v1/device/project`;
    const sensors = [{ name: 'front', x_cm: 0, y_cm: 30, clearance_cm: 3 }];
    const center = { x_cm: 6, y_cm: 10 };
    const fixture = { ...DEVICE, sensors, rotation_center: center };

    service.getLocalDeviceInfo('project').subscribe(info => {
      expect(info.sensors).toEqual(sensors);
      expect(info.rotation_center).toEqual(center);
    });
    http.expectOne({ method: 'GET', url: `${base}/info` }).flush(fixture);
    service.updateLocalDeviceSensors('project', sensors).subscribe();
    const saveSensors = http.expectOne({ method: 'PUT', url: `${base}/sensors` });
    expect(saveSensors.request.body).toEqual({ sensors });
    saveSensors.flush(fixture);
    service.updateLocalDeviceRotationCenter('project', center).subscribe();
    const saveCenter = http.expectOne({ method: 'PUT', url: `${base}/rotation-center` });
    expect(saveCenter.request.body).toEqual({ rotation_center: center });
    saveCenter.flush(fixture);
  });
});

function restoreStorage(key: string, value: string | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}
