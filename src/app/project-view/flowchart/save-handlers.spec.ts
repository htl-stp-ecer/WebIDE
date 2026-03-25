import { handleSave } from './save-handlers';
import type { Flowchart } from './flowchart';
import type { Mission } from '../../entities/Mission';

describe('handleSave', () => {
  let mission: Mission;
  let saveMissionSpy: jasmine.Spy;
  let flow: Flowchart;

  beforeEach(() => {
    mission = {
      name: 'mission',
      is_setup: false,
      is_shutdown: false,
      order: 0,
      steps: [],
      comments: [],
    };

    saveMissionSpy = jasmine.createSpy('saveMission').and.returnValue({
      subscribe: ({ next }: { next?: () => void }) => {
        next?.();
        return {};
      },
    });

    flow = {
      missionState: { currentMission: () => mission } as any,
      projectUUID: 'proj-123',
      historyManager: {
        hasUnsavedChanges: () => true,
        markSaved: jasmine.createSpy('markSaved'),
      } as any,
      http: { saveMission: saveMissionSpy } as any,
      setSaveStatus: jasmine.createSpy('setSaveStatus'),
      invalidateProjectSimulationCache: jasmine.createSpy('invalidateProjectSimulationCache'),
      updatePlannedPathForMission: jasmine.createSpy('updatePlannedPathForMission'),
    } as unknown as Flowchart;
  });

  it('invalidates the project simulation cache before refreshing the planned path', () => {
    const callOrder: string[] = [];
    (flow.invalidateProjectSimulationCache as jasmine.Spy).and.callFake(() => {
      callOrder.push('invalidate');
    });
    (flow.updatePlannedPathForMission as jasmine.Spy).and.callFake(() => {
      callOrder.push('refresh');
    });

    handleSave(flow);

    expect(saveMissionSpy).toHaveBeenCalledWith('proj-123', mission);
    expect(flow.invalidateProjectSimulationCache).toHaveBeenCalled();
    expect(flow.updatePlannedPathForMission).toHaveBeenCalledWith(mission);
    expect(callOrder).toEqual(['invalidate', 'refresh']);
  });
});
