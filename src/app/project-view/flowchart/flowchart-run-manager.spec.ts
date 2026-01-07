import { signal } from '@angular/core';
import { NEVER } from 'rxjs';
import { HttpService } from '../../services/http-service';
import { FlowchartRunManager } from './flowchart-run-manager';

describe('FlowchartRunManager', () => {
  it('scopes node elapsedMs to the current run session', () => {
    const httpStub = {
      runMission: () => NEVER,
      stopMission: () => NEVER,
    } as unknown as HttpService;

    const manager = new FlowchartRunManager({
      http: httpStub,
      isRunActive: signal(false),
      debugState: signal('idle' as any),
      breakpointInfo: signal(null),
      getProjectUUID: () => 'project',
      getMissionKey: () => 'mission',
    } as any);

    manager.updatePathLookups(new Map([['1', 'node-1'], ['2', 'node-2']]), new Map());

    manager.onRun('normal');

    const runStartSeconds = 1000;
    manager.handleRunEvent({ type: 'started', timestamp: runStartSeconds });

    manager.handleRunEvent({
      type: 'step_timing',
      signature: 'old-step',
      duration_seconds: 100,
      recorded_at: runStartSeconds - 100,
    });

    manager.handleRunEvent({
      type: 'step',
      index: 1,
      path: [1],
      display_label: 'Step 1',
      timestamp: runStartSeconds + 1.5,
    });

    const node1Timing = manager.getNodeTiming('node-1');
    expect(node1Timing).toBeTruthy();
    expect(node1Timing!.elapsedMs).toBeCloseTo(1500, 0);

    manager.handleRunEvent({
      type: 'step',
      index: 2,
      path: [2],
      display_label: 'Step 2',
      timestamp: runStartSeconds + 3.0,
    });

    const node2Timing = manager.getNodeTiming('node-2');
    expect(node2Timing).toBeTruthy();
    expect(node2Timing!.elapsedMs).toBeCloseTo(3000, 0);

    expect(manager.stepTimings().length).toBe(3);
    expect(manager.stepTimings()[0].signature).toBe('old-step');
  });
});

