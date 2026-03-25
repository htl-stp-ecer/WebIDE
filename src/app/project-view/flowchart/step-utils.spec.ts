import { MissionStep } from '../../entities/MissionStep';
import {
  asStepFromPool,
  availableBuilderChainMethods,
  canonicalizeMissionStepArguments,
  initialArgsFromPool,
  missionStepFromAdHoc,
  prepareStepForFlowEditor,
  setBuilderChainMethodSelection,
} from './step-utils';
import { Step } from './models';

describe('step-utils canonicalizeMissionStepArguments', () => {
  it('rewrites planner follow_line arguments to the catalog argument name', () => {
    const plannerStep: MissionStep = {
      step_type: 'follow_line',
      function_name: 'follow_line',
      arguments: [{ name: 'cm', value: 68, type: 'float' }],
      position: { x: 0, y: 0 },
      children: [],
    };
    const pool: Step[] = [
      {
        name: 'follow_line',
        import: null,
        file: '',
        arguments: [
          { name: 'left_sensor', type: 'IRSensor', default: 'front_left' },
          { name: 'right_sensor', type: 'IRSensor', default: 'front_right' },
          { name: 'distance_cm', type: 'float', default: null },
          { name: 'forward_speed', type: 'float', default: 0.5 },
        ],
      },
    ];

    const normalized = canonicalizeMissionStepArguments(plannerStep, pool);

    expect(normalized.arguments).toEqual([
      { name: 'left_sensor', value: 'front_left', type: 'IRSensor' },
      { name: 'right_sensor', value: 'front_right', type: 'IRSensor' },
      { name: 'distance_cm', value: 68, type: 'float' },
      { name: 'forward_speed', value: 0.5, type: 'float' },
    ]);
  });

  it('normalizes nested children recursively', () => {
    const plannerStep: MissionStep = {
      step_type: 'seq',
      function_name: 'seq',
      arguments: [],
      position: { x: 0, y: 0 },
      children: [
        {
          step_type: 'follow_line',
          function_name: 'follow_line',
          arguments: [{ name: 'cm', value: 12, type: 'float' }],
          position: { x: 0, y: 0 },
          children: [],
        },
      ],
    };
    const pool: Step[] = [
      {
        name: 'follow_line',
        import: null,
        file: '',
        arguments: [
          { name: 'left_sensor', type: 'IRSensor', default: 'front_left' },
          { name: 'right_sensor', type: 'IRSensor', default: 'front_right' },
          { name: 'distance_cm', type: 'float', default: null },
        ],
      },
    ];

    const normalized = canonicalizeMissionStepArguments(plannerStep, pool);

    expect(normalized.children[0].arguments).toEqual([
      { name: 'left_sensor', value: 'front_left', type: 'IRSensor' },
      { name: 'right_sensor', value: 'front_right', type: 'IRSensor' },
      { name: 'distance_cm', value: 12, type: 'float' },
    ]);
  });

  it('prefers a populated alias over an empty duplicate when hydrating node args', () => {
    const storedStep: MissionStep = {
      step_type: '',
      function_name: 'turn_cw',
      arguments: [
        { name: 'deg', value: null, type: 'float' },
        { name: 'degrees', value: 90, type: 'float' },
      ],
      position: { x: 0, y: 0 },
      children: [],
    };
    const pool: Step[] = [
      {
        name: 'turn_cw',
        import: null,
        file: '',
        arguments: [
          { name: 'deg', type: 'float', default: null },
        ],
      },
    ];

    expect(initialArgsFromPool(storedStep, pool)).toEqual({ deg: 90 });
  });

  it('drops stale alias duplicates when canonicalizing turn arguments', () => {
    const storedStep: MissionStep = {
      step_type: '',
      function_name: 'turn_cw',
      arguments: [
        { name: 'deg', value: null, type: 'float' },
        { name: 'degrees', value: 90, type: 'float' },
      ],
      position: { x: 0, y: 0 },
      children: [],
    };
    const pool: Step[] = [
      {
        name: 'turn_cw',
        import: null,
        file: '',
        arguments: [
          { name: 'deg', type: 'float', default: null },
        ],
      },
    ];

    expect(canonicalizeMissionStepArguments(storedStep, pool).arguments).toEqual([
      { name: 'deg', value: 90, type: 'float' },
    ]);
  });

  it('infers numeric UI types for fallback mission arguments parsed as keyword bindings', () => {
    const storedStep: MissionStep = {
      step_type: '',
      function_name: 'turn_ccw',
      arguments: [
        { name: 'deg', value: 13, type: 'keyword' },
      ],
      position: { x: 0, y: 0 },
      children: [],
    };

    const fallbackStep = asStepFromPool(storedStep, []);
    expect(fallbackStep.arguments[0].name).toBe('deg');
    expect(fallbackStep.arguments[0].type).toBe('int');
    expect(fallbackStep.arguments[0].default).toBe(13);
    expect(initialArgsFromPool(storedStep, [])).toEqual({ deg: 13 });
  });

  it('normalizes packingbot until-builder step names for fallback rendering', () => {
    const storedStep: MissionStep = {
      step_type: 'strafe_right().until',
      function_name: 'strafe_right().until',
      arguments: [
        { name: null as any, value: 'on_black(Defs.rear.right)', type: 'positional' },
      ],
      position: { x: 0, y: 0 },
      children: [],
    };

    const fallbackStep = asStepFromPool(storedStep, []);
    expect(fallbackStep.name).toBe('strafe_right_until_black');
    expect(fallbackStep.arguments[0].name).toBe('condition');
    expect(fallbackStep.arguments[0].type).toBe('str');
    expect(initialArgsFromPool(storedStep, [])).toEqual({ condition: 'on_black(Defs.rear.right)' });
  });

  it('derives a display name from compound until-builder conditions', () => {
    const storedStep: MissionStep = {
      step_type: 'drive_forward().until',
      function_name: 'drive_forward().until',
      arguments: [
        { name: null as any, value: 'after_cm(125) & on_black(Defs.front.left)', type: 'positional' },
      ],
      position: { x: 0, y: 0 },
      children: [],
    };

    const fallbackStep = asStepFromPool(storedStep, []);
    expect(fallbackStep.name).toBe('drive_forward_until_black');
    expect(initialArgsFromPool(storedStep, [])).toEqual({
      condition: 'after_cm(125) & on_black(Defs.front.left)',
    });
  });

  it('extracts inline builder arguments from chained distance setters', () => {
    const storedStep: MissionStep = {
      step_type: 'strafe_follow_line_single(Defs.front.right, speed=-1, side=LineSide.RIGHT, kp=0.4, kd=0.1).distance_cm',
      function_name: 'strafe_follow_line_single(Defs.front.right, speed=-1, side=LineSide.RIGHT, kp=0.4, kd=0.1).distance_cm',
      arguments: [
        { name: null as any, value: 15, type: 'positional' },
      ],
      position: { x: 0, y: 0 },
      children: [],
    };

    const fallbackStep = asStepFromPool(storedStep, []);
    expect(fallbackStep.name).toBe('strafe_follow_line_single.distance_cm');
    expect(fallbackStep.arguments.map(arg => arg.name)).toEqual([
      'arg0',
      'speed',
      'side',
      'kp',
      'kd',
      'distance_cm',
    ]);
    expect(initialArgsFromPool(storedStep, [])).toEqual({
      arg0: 'Defs.front.right',
      speed: -1,
      side: 'LineSide.RIGHT',
      kp: 0.4,
      kd: 0.1,
      distance_cm: 15,
    });
  });

  it('parses multiline chained builder setters from the backend formatter', () => {
    const storedStep: MissionStep = {
      step_type: `strafe_follow_line_single(
Defs.front.left, speed=1.0,
side=LineSide.LEFT,
kp=0.5, kd=0.1,
).distance_cm`,
      function_name: `strafe_follow_line_single(
Defs.front.left, speed=1.0,
side=LineSide.LEFT,
kp=0.5, kd=0.1,
).distance_cm`,
      arguments: [
        { name: null as any, value: 15, type: 'positional' },
      ],
      position: { x: 0, y: 0 },
      children: [],
    };

    const fallbackStep = asStepFromPool(storedStep, []);
    expect(fallbackStep.name).toBe('strafe_follow_line_single.distance_cm');
    expect(initialArgsFromPool(storedStep, [])).toEqual({
      arg0: 'Defs.front.left',
      speed: 1,
      side: 'LineSide.LEFT',
      kp: 0.5,
      kd: 0.1,
      distance_cm: 15,
    });
  });

  it('allows recursive chain selection from catalog metadata', () => {
    const editable = prepareStepForFlowEditor({
      name: 'drive_forward',
      import: null,
      file: '',
      arguments: [],
      chainMethods: [
        {
          name: 'until',
          arguments: [{ name: 'condition', type: 'str', default: null }],
          recursive: true,
        },
      ],
    } as Step);

    let args = setBuilderChainMethodSelection(editable, {}, 0, 'until');
    expect(availableBuilderChainMethods(editable, 1).map(method => method.name)).toEqual(['until']);
    expect(editable.chainSelections?.map(selection => selection.methodName)).toEqual(['until']);
    expect(editable.chainSelections?.[0]?.arguments[0]?.label).toBe('condition');

    args = { ...args, condition: 'on_black(Defs.front.left)' };
    args = setBuilderChainMethodSelection(editable, args, 1, 'until');

    expect(editable.chainSelections?.map(selection => selection.methodName)).toEqual(['until', 'until']);
    expect(editable.chainSelections?.[1]?.arguments[0]?.label).toBe('condition');
    expect(editable.chainSelections?.[1]?.arguments[0]?.name).not.toBe('condition');
  });

  it('serializes recursive chain selections back into backend mission shape', () => {
    const editable = prepareStepForFlowEditor({
      name: 'drive_forward',
      import: null,
      file: '',
      arguments: [],
      chainMethods: [
        {
          name: 'until',
          arguments: [{ name: 'condition', type: 'str', default: null }],
          recursive: true,
        },
      ],
    } as Step);

    let args = setBuilderChainMethodSelection(editable, {}, 0, 'until');
    args['condition'] = 'on_black(Defs.front.left)';
    args = setBuilderChainMethodSelection(editable, args, 1, 'until');
    const secondConditionKey = editable.chainSelections?.[1]?.arguments[0]?.name as string;
    args[secondConditionKey] = 'after_cm(12)';

    const missionStep = missionStepFromAdHoc({
      id: 'node-1',
      text: editable.name,
      position: { x: 0, y: 0 },
      step: editable,
      args,
    });

    expect(missionStep.function_name).toBe('drive_forward().until(on_black(Defs.front.left)).until');
    expect(missionStep.arguments).toEqual([{ name: '', value: 'after_cm(12)', type: 'positional' }]);
  });

  it('does not offer further chain methods when the selected method is not recursive and has no children', () => {
    const editable = prepareStepForFlowEditor({
      name: 'strafe_follow_line_single',
      import: null,
      file: '',
      arguments: [],
      chainMethods: [
        {
          name: 'distance_cm',
          arguments: [{ name: 'distance_cm', type: 'float', default: null }],
        },
      ],
    } as Step);

    setBuilderChainMethodSelection(editable, {}, 0, 'distance_cm');

    expect(availableBuilderChainMethods(editable, 1)).toEqual([]);
  });
});
