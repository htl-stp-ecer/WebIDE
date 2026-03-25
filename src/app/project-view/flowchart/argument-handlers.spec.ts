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
      historyManager: {
        recordHistory: jasmine.createSpy('recordHistory'),
        hasUnsavedChanges: () => true,
        markSaved: jasmine.createSpy('markSaved'),
      } as any,
      missionState: { currentMission: () => mission } as any,
      projectUUID: 'proj-123',
      http: { saveMission: saveMissionSpy } as any,
      setSaveStatus: jasmine.createSpy('setSaveStatus'),
    } as unknown as Flowchart;
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

  it('serializes multi-sensor selections to a backend-compatible expression', () => {
    const node = flow.nodes()[0];
    node.step.arguments[0].type = 'Union[IRSensor, list[IRSensor]]';
    missionStep.arguments[0].type = 'Union[IRSensor, list[IRSensor]]';

    handleArgumentChange(flow, nodeId, 'Arg', 0, ['left_ir_sensor', 'right_ir_sensor']);
    expect(missionStep.arguments[0].value).toBe('[left_ir_sensor, right_ir_sensor]');

    handleArgumentChange(flow, nodeId, 'Arg', 0, ['left_ir_sensor']);
    expect(missionStep.arguments[0].value).toBe('left_ir_sensor');

    handleArgumentChange(flow, nodeId, 'Arg', 0, []);
    expect(missionStep.arguments[0].value).toBeNull();
  });

  it('stores integer arguments without fractional digits', () => {
    const node = flow.nodes()[0];
    node.step.arguments[0].type = 'int';
    missionStep.arguments[0].type = 'int';

    handleArgumentChange(flow, nodeId, 'Arg', 0, 123.9);
    expect(missionStep.arguments[0].value).toBe(123);
  });

  it('keeps numeric values for Any-typed arguments', () => {
    const node = flow.nodes()[0];
    node.step.arguments[0].type = 'Any';
    missionStep.arguments[0].type = 'Any';

    handleArgumentChange(flow, nodeId, 'Arg', 0, 300);
    expect(missionStep.arguments[0].value).toBe(300);
  });

  it('re-serializes derived builder arguments back into the raw mission step shape', () => {
    missionStep = {
      step_type: 'strafe_follow_line_single(Defs.front.right, speed=-1, side=LineSide.RIGHT, kp=0.4, kd=0.1).distance_cm',
      function_name: 'strafe_follow_line_single(Defs.front.right, speed=-1, side=LineSide.RIGHT, kp=0.4, kd=0.1).distance_cm',
      arguments: [{ name: '', value: 15, type: 'positional' }],
      children: [],
    };
    mission.steps = [missionStep];

    const flowNode: FlowNode = {
      id: nodeId,
      text: 'strafe_follow_line_single.distance_cm',
      position: { x: 0, y: 0 },
      step: {
        name: 'strafe_follow_line_single.distance_cm',
        builderBaseName: 'strafe_follow_line_single',
        builderMethodName: 'distance_cm',
        arguments: [
          { name: 'arg0', type: 'str', builderSource: 'base', builderBinding: 'positional', builderRawName: null },
          { name: 'speed', type: 'int', builderSource: 'base', builderBinding: 'keyword', builderRawName: 'speed' },
          { name: 'side', type: 'str', builderSource: 'base', builderBinding: 'keyword', builderRawName: 'side' },
          { name: 'kp', type: 'float', builderSource: 'base', builderBinding: 'keyword', builderRawName: 'kp' },
          { name: 'kd', type: 'float', builderSource: 'base', builderBinding: 'keyword', builderRawName: 'kd' },
          { name: 'distance_cm', type: 'int', builderSource: 'method', builderBinding: 'positional', builderRawName: null },
        ],
      },
      args: {
        arg0: 'Defs.front.right',
        speed: -1,
        side: 'LineSide.RIGHT',
        kp: 0.4,
        kd: 0.1,
        distance_cm: 15,
      },
    };

    const nodesSignal = createSignal([flowNode]);
    (flow as any).nodes = nodesSignal as any;
    (flow as any).lookups = {
      nodeIdToStep: new Map([[nodeId, missionStep]]),
      stepToNodeId: new Map([[missionStep, nodeId]]),
    } as any;

    handleArgumentChange(flow, nodeId, 'distance_cm', 5, 22);

    expect(missionStep.function_name).toBe(
      'strafe_follow_line_single(Defs.front.right, speed=-1, side=LineSide.RIGHT, kp=0.4, kd=0.1).distance_cm'
    );
    expect(missionStep.arguments).toEqual([{ name: '', value: 22, type: 'positional' }]);
  });
});
