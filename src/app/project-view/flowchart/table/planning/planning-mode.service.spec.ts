import { TestBed } from '@angular/core/testing';

import { PlanningModeService } from './planning-mode.service';
import { TableMapService, TableVisualizationService } from '../services';

describe('PlanningModeService', () => {
  let service: PlanningModeService;
  let mapService: TableMapService;
  let vizService: TableVisualizationService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PlanningModeService);
    mapService = TestBed.inject(TableMapService);
    vizService = TestBed.inject(TableVisualizationService);

    service.clear();
    mapService.clear();
    vizService.reset();
    service.setStartPose(10, 10, 0);
  });

  it('computes an end pose for a simple forward path', () => {
    const steps = (service as any).generateStepsDirectly(
      [{ id: 'wp-1', x: 25, y: 10 }],
      { x: 10, y: 10, theta: 0 },
      0.5
    );
    (service as any)._generatedSteps.set(steps);

    const trajectory = service.computedTrajectory();
    const endPose = service.endPose();

    expect(trajectory.length).toBeGreaterThan(1);
    expect(endPose).not.toBeNull();
    expect(endPose?.x).toBeCloseTo(25, 1);
    expect(endPose?.y).toBeCloseTo(10, 1);
    expect(endPose?.theta).toBeCloseTo(0, 4);
  });
});
