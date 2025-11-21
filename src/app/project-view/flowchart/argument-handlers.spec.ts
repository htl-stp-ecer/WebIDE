import { handleArgumentChange } from './argument-handlers';
import type { Flowchart } from './flowchart';
import type { FlowNode } from './models';
import type { Mission } from '../../entities/Mission';
import type { MissionStep } from '../../entities/MissionStep';

describe('handleArgumentChange', () => {
  let flow: Flowchart;
  let mission: Mission;
  let missionStep: MissionStep;
  const nodeId = 'node-1';
  let saveMissionSpy: jasmine.Spy;

  const createSignal = <T>(initial: T) => {
    let value = initial;
    const fn = () => value;
    fn.set = (next: T) => {
      value = next;
    };
    return fn;
  };

  beforeEach(() => {
    jasmine.clock().install();
    missionStep = {
      step_type: 'task',
      function_name: 'Node',
      arguments: [{ name: 'Arg', value: 'initial', type: 'str' }],
      children: [],
    };
    mission = {
      name: 'mission',
      is_setup: false,
      is_shutdown: false,
      order: 0,
      steps: [missionStep],
      comments: [],
    };

    const flowNode: FlowNode = {
      id: nodeId,
      text: 'Node',
      position: { x: 0, y: 0 },
      step: {
        name: 'Node',
        arguments: [{ name: 'Arg', type: 'str' }],
      },
      args: { Arg: 'initial' },
    };

    const nodesSignal = createSignal([flowNode]);
    const adHocSignal = createSignal<FlowNode[]>([]);

    saveMissionSpy = jasmine.createSpy('saveMission').and.returnValue({
      subscribe: () => ({}),
    });

    flow = {
      nodes: nodesSignal as any,
      adHocNodes: adHocSignal as any,
      lookups: {
        nodeIdToStep: new Map([[nodeId, missionStep]]),
        stepToNodeId: new Map([[missionStep, nodeId]]),
      } as any,
      historyManager: { recordHistory: jasmine.createSpy('recordHistory') } as any,
      missionState: { currentMission: () => mission } as any,
      projectUUID: 'proj-123',
      http: { saveMission: saveMissionSpy } as any,
    } as Flowchart;
  });

  afterEach(() => {
    jasmine.clock().uninstall();
  });

  it('saves the mission shortly after an argument change', () => {
    handleArgumentChange(flow, nodeId, 'Arg', 0, 'updated');
    expect(saveMissionSpy).not.toHaveBeenCalled();
    jasmine.clock().tick(500);
    expect(saveMissionSpy).toHaveBeenCalledTimes(1);
    expect(saveMissionSpy).toHaveBeenCalledWith('proj-123', mission);
  });

  it('debounces multiple quick argument edits into a single save', () => {
    handleArgumentChange(flow, nodeId, 'Arg', 0, 'first');
    jasmine.clock().tick(200);
    handleArgumentChange(flow, nodeId, 'Arg', 0, 'second');

    jasmine.clock().tick(400);
    expect(saveMissionSpy).not.toHaveBeenCalled();
    jasmine.clock().tick(200);
    expect(saveMissionSpy).toHaveBeenCalledTimes(1);
  });
});
