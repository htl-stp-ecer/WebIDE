import { rebuildMissionView } from './mission-builder';
import { asStepFromPool, initialArgsFromPool } from './step-utils';
import { Mission } from '../../entities/Mission';

describe('mission-builder', () => {
  it('uses the normalized fallback step name as node text for until-builder steps', () => {
    const mission: Mission = {
      name: 'PackingbotMission',
      is_setup: false,
      is_shutdown: false,
      order: 1,
      steps: [
        {
          step_type: 'strafe_right().until',
          function_name: 'strafe_right().until',
          arguments: [
            { name: null as any, value: 'on_black(Defs.rear.right)', type: 'positional' },
          ],
          position: { x: 10, y: 20 },
          children: [],
        },
      ],
    };

    const result = rebuildMissionView(
      mission,
      new Map(),
      step => asStepFromPool(step, []),
      step => initialArgsFromPool(step, []),
      'start-node-output',
    );

    expect(result.nodes).toHaveSize(1);
    expect(result.nodes[0].text).toBe('strafe_right_until_black');
    expect(result.nodes[0].step.name).toBe('strafe_right_until_black');
    expect(result.nodes[0].args).toEqual({ condition: 'on_black(Defs.rear.right)' });
  });

  it('shows compact node text for chained builder setter steps and exposes all parsed args', () => {
    const mission: Mission = {
      name: 'PackingbotMission',
      is_setup: false,
      is_shutdown: false,
      order: 1,
      steps: [
        {
          step_type: 'strafe_follow_line_single(Defs.front.right, speed=-1, side=LineSide.RIGHT, kp=0.4, kd=0.1).distance_cm',
          function_name: 'strafe_follow_line_single(Defs.front.right, speed=-1, side=LineSide.RIGHT, kp=0.4, kd=0.1).distance_cm',
          arguments: [
            { name: null as any, value: 15, type: 'positional' },
          ],
          position: { x: 10, y: 20 },
          children: [],
        },
      ],
    };

    const result = rebuildMissionView(
      mission,
      new Map(),
      step => asStepFromPool(step, []),
      step => initialArgsFromPool(step, []),
      'start-node-output',
    );

    expect(result.nodes).toHaveSize(1);
    expect(result.nodes[0].text).toBe('strafe_follow_line_single.distance_cm');
    expect(result.nodes[0].args).toEqual({
      arg0: 'Defs.front.right',
      speed: -1,
      side: 'LineSide.RIGHT',
      kp: 0.4,
      kd: 0.1,
      distance_cm: 15,
    });
  });
});
