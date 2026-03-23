import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { of, throwError } from 'rxjs';

import { ProjectMenu } from './project-menu';
import { HttpService } from '../services/http-service';
import { ConfirmationService } from 'primeng/api';
import { TranslateService } from '@ngx-translate/core';
import { NotificationService } from '../services/NotificationService';

class MockTranslateService {
  instant(key: string) { return key; }
}

describe('ProjectMenu UI behavior', () => {
  let component: ProjectMenu;
  let fixture: ComponentFixture<ProjectMenu>;

  const httpMock = {
    setDeviceBase: jasmine.createSpy('setDeviceBase'),
    clearDeviceBase: jasmine.createSpy('clearDeviceBase'),
    getDeviceInfoDefault: jasmine.createSpy('getDeviceInfoDefault').and.returnValue(of({
      hostname: 'Raccoon bot',
      ip: 'http://127.0.0.1:8000',
    })),
    getDeviceProjects: jasmine.createSpy('getDeviceProjects').and.returnValue(of([
      { uuid: 'abc-12345', name: 'Alpha Project' },
      { uuid: 'def-67890', name: 'Beta Project' },
    ])),
    createDeviceProject: jasmine.createSpy('createDeviceProject').and.returnValue(of({
      uuid: 'ghi-24680',
      name: 'Gamma Project',
    })),
    changeHostname: jasmine.createSpy('changeHostname').and.returnValue(of({ hostname: 'Updated bot' })),
    deleteDeviceProject: jasmine.createSpy('deleteDeviceProject').and.returnValue(of({})),
  } as unknown as HttpService;

  const confirmationMock = {
    confirm: jasmine.createSpy('confirm'),
  };

  const routerMock = {
    navigate: jasmine.createSpy('navigate'),
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProjectMenu],
      providers: [
        { provide: Router, useValue: routerMock },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ ip: '127_0_0_1-8000' }) } },
        },
        { provide: HttpService, useValue: httpMock },
        { provide: ConfirmationService, useValue: confirmationMock },
        { provide: TranslateService, useClass: MockTranslateService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ProjectMenu);
    component = fixture.componentInstance;
    fixture.detectChanges();

    if (!jasmine.isSpy(NotificationService.showSuccess)) {
      spyOn(NotificationService, 'showSuccess');
    }
    if (!jasmine.isSpy(NotificationService.showError)) {
      spyOn(NotificationService, 'showError');
    }

    (NotificationService.showSuccess as jasmine.Spy).calls.reset();
    (NotificationService.showError as jasmine.Spy).calls.reset();
    (httpMock.createDeviceProject as jasmine.Spy).calls.reset();
    (httpMock.changeHostname as jasmine.Spy).calls.reset();
    (httpMock.deleteDeviceProject as jasmine.Spy).calls.reset();
    confirmationMock.confirm.calls.reset();
    routerMock.navigate.calls.reset();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('loads device and projects on init', () => {
    expect(httpMock.setDeviceBase).toHaveBeenCalled();
    expect(component.loading).toBeFalse();
    expect(component.projectsLoading).toBeFalse();
    expect(component.connectionInfo?.hostname).toBe('Raccoon bot');
    expect(component.projects.length).toBe(2);

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Alpha Project');
    expect(text).toContain('Beta Project');
  });

  it('enters and exits inline edit mode', () => {
    component.enableEdit();
    expect(component.editingName).toBeTrue();

    component.tempName = 'different';
    component.disableEdit();
    expect(component.editingName).toBeFalse();
    expect(component.tempName).toBe('Raccoon bot');
  });

  it('does not save empty hostname', () => {
    component.editingName = true;
    component.tempName = '   ';
    component.finishEdit();

    expect(httpMock.changeHostname).not.toHaveBeenCalled();
    expect(component.editingName).toBeTrue();
  });

  it('routes back to home when back action is clicked', () => {
    component.backToProjects();
    expect(routerMock.navigate).toHaveBeenCalledWith(['/']);
  });

  it('shows and hides the create project form', () => {
    component.startCreateProject();
    expect(component.creatingProject).toBeTrue();

    component.newProjectName = 'Temporary';
    component.cancelCreateProject();

    expect(component.creatingProject).toBeFalse();
    expect(component.newProjectName).toBe('');
  });

  it('creates a project and prepends it to the list', () => {
    component.startCreateProject();
    component.newProjectName = 'Gamma Project';

    component.createProject();

    expect(httpMock.createDeviceProject).toHaveBeenCalledWith('Gamma Project');
    expect(component.creatingProject).toBeFalse();
    expect(component.creatingProjectPending).toBeFalse();
    expect(component.newProjectName).toBe('');
    expect(component.projects[0]).toEqual({ uuid: 'ghi-24680', name: 'Gamma Project' });
  });

  it('does not create an empty project', () => {
    component.startCreateProject();
    component.newProjectName = '   ';

    component.createProject();

    expect(httpMock.createDeviceProject).not.toHaveBeenCalled();
    expect(component.creatingProject).toBeTrue();
  });

  it('marks projects loading complete when project fetch fails', () => {
    (httpMock.getDeviceProjects as jasmine.Spy).and.returnValue(throwError(() => new Error('boom')));

    const retryFixture = TestBed.createComponent(ProjectMenu);
    const retryComponent = retryFixture.componentInstance;
    retryFixture.detectChanges();

    expect(retryComponent.projectsLoading).toBeFalse();
    expect(retryComponent.projects.length).toBe(0);
  });
});
