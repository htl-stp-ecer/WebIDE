import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { RouterTestingHarness } from '@angular/router/testing';

import { appConfig } from '../app.config';
import { ProjectView } from './project-view';

const PROJECT_A = '78dcbdbc-9718-4cb3-a23c-a16a4edb3a92';
const PROJECT_B = '17431732-49a2-43b9-914b-aa71ffd0a077';

describe('Project editor navigation', () => {
  it('opens a fresh editor and catalog for a changed UUID and preserves the editor for query changes', async () => {
    TestBed.configureTestingModule({
      providers: [...appConfig.providers, provideHttpClientTesting()],
    });
    TestBed.overrideComponent(ProjectView, {
      set: {
        template: '{{ projectUUID }} {{ stepsState.currentSteps()?.[0]?.name }}',
      },
    });
    const http = TestBed.inject(HttpTestingController);
    const harness = await RouterTestingHarness.create();

    const first = await harness.navigateByUrl(`/projects/${PROJECT_A}`, ProjectView);
    const oldRequests = http.match(request => request.url.includes(PROJECT_A));
    expect(oldRequests.length).toBe(4);
    expect(first.projectUUID).toBe(PROJECT_A);
    expect(await harness.navigateByUrl(`/projects/${PROJECT_A}?tab=steps`, ProjectView)).toBe(first);

    const second = await harness.navigateByUrl(`/projects/${PROJECT_B}`, ProjectView);
    expect(second).not.toBe(first);
    expect(oldRequests.every(request => request.cancelled)).toBeTrue();
    expect(second.projectUUID).toBe(PROJECT_B);

    http.expectOne(request => request.url.endsWith(`/api/v1/steps/?project_uuid=${PROJECT_B}`))
      .flush([{ name: 'new_project_step', import: 'steps.project', file: 'steps/project.py', arguments: [] }]);
    http.expectOne(request => request.url.endsWith(`/api/v1/device/${PROJECT_B}/info`))
      .flush({ hostname: 'local', ip: '127.0.0.1' });
    http.expectOne(request => request.url.endsWith(`/api/v1/projects/${PROJECT_B}`))
      .flush({ name: 'Second project', uuid: PROJECT_B });
    http.expectOne(request => request.url.endsWith(`/api/v1/run-configurations/${PROJECT_B}`))
      .flush({ configurations: [] });
    harness.detectChanges();

    expect(harness.routeNativeElement?.textContent?.trim()).toBe(`${PROJECT_B} new_project_step`);
    http.verify();
  });
});
