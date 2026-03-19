import { MissionStep } from '../../entities/MissionStep';
import { canonicalizeMissionStepArguments } from './step-utils';
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
});
