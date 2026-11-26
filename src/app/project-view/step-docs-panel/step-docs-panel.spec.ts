import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { HttpService } from '../../services/http-service';
import { KeybindingsService } from '../../services/keybindings-service';
import { StepsStateService } from '../../services/steps-state-service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { enTranslations } from '../../i18n/translations';
import { RobotSettingsModal } from '../flowchart/robot-settings/robot-settings-modal';
import { StepDocsPanel } from './step-docs-panel';

const PROJECT_A = '78dcbdbc-9718-4cb3-a23c-a16a4edb3a92';
const PROJECT_B = '17431732-49a2-43b9-914b-aa71ffd0a077';

function step(name: string): Step {
  return { name, import: 'steps.project', file: 'steps/project.py', tags: ['project'], arguments: [] };
}

describe('Project step catalog', () => {
  let fixture: ComponentFixture<StepDocsPanel>;
  let http: HttpTestingController;
  let service: HttpService;
  let state: StepsStateService;
  let originalPort: string | null;

  beforeEach(() => {
    originalPort = localStorage.getItem('localBackendPort');
    TestBed.configureTestingModule({
      imports: [StepDocsPanel, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', enTranslations);
    translate.use('en');
    fixture = TestBed.createComponent(StepDocsPanel);
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(HttpService);
    state = TestBed.inject(StepsStateService);
  });

  afterEach(() => {
    http.verify();
    if (originalPort === null) localStorage.removeItem('localBackendPort');
    else localStorage.setItem('localBackendPort', originalPort);
  });

  function requestSteps(uuid: string) {
    return http.expectOne(request => request.method === 'GET' &&
      request.url.endsWith(`/api/v1/steps/?project_uuid=${uuid}`));
  }

  function renderedSteps(): (string | undefined)[] {
    fixture.detectChanges();
    return Array.from(fixture.nativeElement.querySelectorAll('.docs-card-sig .sig-name') as NodeListOf<HTMLElement>)
      .map(item => item.textContent?.trim());
  }

  it('shows a renamed project step after refresh in the catalog', () => {
    state.setProject(PROJECT_A);
    requestSteps(PROJECT_A).flush([step('old_step')]);
    expect(renderedSteps()).toEqual(['old_step']);
    const card = fixture.nativeElement.querySelector('.docs-card-summary') as HTMLElement;
    expect(card.hasAttribute('fExternalItem')).toBeTrue();
    const toggle = fixture.nativeElement.querySelector('.docs-card-toggle') as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    http.expectNone(request => request.url.includes('/api/v1/steps/'));

    state.triggerRefresh();
    requestSteps(PROJECT_A).flush([step('renamed_step')]);
    expect(renderedSteps()).toEqual(['renamed_step']);
  });

  it('cancels superseded requests and switches the palette when the project changes', () => {
    state.setProject(PROJECT_A);
    requestSteps(PROJECT_A).flush([step('first_project')]);
    expect(renderedSteps()).toEqual(['first_project']);

    state.triggerRefresh();
    const superseded = requestSteps(PROJECT_A);
    state.triggerRefresh();
    const oldProject = requestSteps(PROJECT_A);
    expect(superseded.cancelled).toBeTrue();

    state.setProject(PROJECT_B);
    expect(oldProject.cancelled).toBeTrue();
    expect(state.currentSteps()).toBeNull();
    state.triggerRefresh(PROJECT_A);
    http.expectNone(request => request.url.includes(PROJECT_A));

    requestSteps(PROJECT_B).flush([step('second_project')]);
    expect(renderedSteps()).toEqual(['second_project']);
  });

  it('cancels the catalog request when the editor is destroyed and ignores late refresh triggers', () => {
    state.setProject(PROJECT_A);
    const pending = requestSteps(PROJECT_A);

    state.ngOnDestroy();
    state.triggerRefresh(PROJECT_A);

    expect(pending.cancelled).toBeTrue();
    http.expectNone(request => request.url.includes(PROJECT_A));
  });

  it('reloads project steps when the library re-index completes with an empty index', () => {
    state.setProject(PROJECT_A);
    requestSteps(PROJECT_A).flush([step('old_step')]);
    const modal = new RobotSettingsModal(service, {} as TranslateService, {} as KeybindingsService, state);
    modal.projectUuid = PROJECT_A;

    modal.refreshStepIndex();
    http.expectOne(request => request.method === 'POST' && request.url.endsWith('/steps/index/refresh'))
      .flush({ status: 'empty', count: 0 });
    requestSteps(PROJECT_A).flush([step('project_only')]);

    expect(renderedSteps()).toEqual(['project_only']);
    modal.ngOnDestroy();
  });

  it('clears filtered stale results on error and lets the active project retry', () => {
    state.setProject(PROJECT_A);
    requestSteps(PROJECT_A).flush([step('my_step')]);
    fixture.componentInstance.searchQuery.set('step');
    expect(renderedSteps()).toEqual(['my_step']);

    state.triggerRefresh();
    requestSteps(PROJECT_A).flush({}, { status: 500, statusText: 'Error' });
    expect(renderedSteps()).toEqual([]);
    expect(fixture.nativeElement.textContent).toContain(enTranslations.STEP_INDEX.LOAD_ERROR);

    state.triggerRefresh();
    requestSteps(PROJECT_A).flush([step('other_step')]);
    expect(renderedSteps()).toEqual(['other_step']);
  });
});
