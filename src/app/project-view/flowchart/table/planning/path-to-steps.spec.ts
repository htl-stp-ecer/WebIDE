import { MissionStep } from '../../../../entities/MissionStep';
import { formatStepForPreview, waypointsToMissionSteps } from './path-to-steps';

describe('path-to-steps', () => {
  it('converts simple waypoint path into drive steps with turn when needed', () => {
    const steps = waypointsToMissionSteps([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 10, y: 0 },
      { id: 'c', x: 10, y: 10 },
    ]);

    expect(steps.map(s => s.function_name)).toEqual([
      'drive_forward',
      'turn_ccw',
      'drive_forward',
    ]);
    expect(steps[0].arguments[0].value).toBe(10);
    expect(steps[1].arguments[0].value).toBe(90);
    expect(steps[2].arguments[0].value).toBe(10);
  });

  it('supports starting heading and tank turn options', () => {
    const steps = waypointsToMissionSteps(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 0, y: 5 },
      ],
      { startHeading: Math.PI, useTankTurn: true }
    );

    expect(steps[0].function_name).toBe('tank_turn_cw');
    expect(steps[0].arguments[0].value).toBe(90);
    expect(steps[1].function_name).toBe('drive_forward');
    expect(steps[1].arguments[0].value).toBe(5);
  });

  it('skips tiny segments and tiny rotations under minRotateDeg', () => {
    const steps = waypointsToMissionSteps(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 0.01, y: 0.02 },
        { id: 'c', x: 5, y: 0.1 },
      ],
      { minRotateDeg: 15 }
    );

    expect(steps.map(s => s.function_name)).toEqual(['drive_forward']);
    expect(steps[0].arguments[0].value).toBe(5);
  });

  it('formats step preview strings by function semantics', () => {
    const examples: MissionStep[] = [
      { function_name: 'forward_lineup_on_black', arguments: [], step_type: '', position: { x: 0, y: 0 }, children: [] },
      { function_name: 'drive_until_white', arguments: [], step_type: '', position: { x: 0, y: 0 }, children: [] },
      { function_name: 'follow_line', arguments: [{ name: 'cm', value: 23, type: 'float' }], step_type: '', position: { x: 0, y: 0 }, children: [] },
      { function_name: 'turn_cw', arguments: [{ name: 'deg', value: 45, type: 'float' }], step_type: '', position: { x: 0, y: 0 }, children: [] },
      { function_name: 'custom_action', arguments: [{ name: 'v', value: 'x', type: 'string' }], step_type: '', position: { x: 0, y: 0 }, children: [] },
      { function_name: 'no_args', arguments: [], step_type: '', position: { x: 0, y: 0 }, children: [] },
    ];

    expect(formatStepForPreview(examples[0])).toBe('lineup(black)');
    expect(formatStepForPreview(examples[1])).toBe('drive_until(white)');
    expect(formatStepForPreview(examples[2])).toBe('follow_line(23cm)');
    expect(formatStepForPreview(examples[3])).toBe('turn_cw(45°)');
    expect(formatStepForPreview(examples[4])).toBe('custom_action(x)');
    expect(formatStepForPreview(examples[5])).toBe('no_args');
  });
  it('formats lineup and control variants across all branch-specific aliases', () => {
    const base = { step_type: '', position: { x: 0, y: 0 }, children: [] };
    expect(formatStepForPreview({ ...base, function_name: 'forward_lineup_on_white', arguments: [] })).toBe('lineup(white)');
    expect(formatStepForPreview({ ...base, function_name: 'backward_lineup_on_black', arguments: [] })).toBe('lineup_bwd(black)');
    expect(formatStepForPreview({ ...base, function_name: 'backward_lineup_on_white', arguments: [] })).toBe('lineup_bwd(white)');
    expect(formatStepForPreview({ ...base, function_name: 'drive_until_black', arguments: [] })).toBe('drive_until(black)');
    expect(formatStepForPreview({ ...base, function_name: 'follow_line', arguments: [] })).toBe('follow_line');
  });

  it('formats generic movement and turn commands consistently', () => {
    const base = { step_type: '', position: { x: 0, y: 0 }, children: [] };
    expect(formatStepForPreview({ ...base, function_name: 'tank_turn_ccw', arguments: [{ name: 'deg', value: 135, type: 'float' }] })).toBe('tank_turn_ccw(135°)');
    expect(formatStepForPreview({ ...base, function_name: 'drive_backward', arguments: [{ name: 'cm', value: 7, type: 'float' }] })).toBe('drive_backward(7cm)');
  });

});
