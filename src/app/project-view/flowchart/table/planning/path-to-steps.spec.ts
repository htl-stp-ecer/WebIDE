import { MissionStep } from '../../../../entities/MissionStep';
import { formatStepForPreview, waypointsToMissionSteps, waypointsToSplineStep } from './path-to-steps';

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

  describe('waypointsToSplineStep', () => {
    const baseOpts = { startX: 0, startY: 0, startHeading: 0, speed: 0.8 };

    it('returns null for fewer than 2 waypoints', () => {
      expect(
        waypointsToSplineStep([{ id: 'a', x: 0, y: 0 }], baseOpts)
      ).toBeNull();
    });

    it('emits a single spline_path step with relative tuples', () => {
      const step = waypointsToSplineStep(
        [
          { id: 'start', x: 0, y: 0 },
          { id: 'b', x: 10, y: 5 },
          { id: 'c', x: 20, y: 0 },
        ],
        baseOpts
      );
      expect(step).not.toBeNull();
      expect(step!.function_name).toBe('spline_path');
      const wpArg = step!.arguments.find((a) => a.name === 'waypoints')!;
      expect(wpArg.type).toBe('list');
      const tuples = JSON.parse(String(wpArg.value)) as number[][];
      // With startHeading=0 the table frame matches the robot frame; left = y.
      expect(tuples).toEqual([
        [0, 0],
        [10, 5],
        [20, 0],
      ]);
      const speedArg = step!.arguments.find((a) => a.name === 'speed')!;
      expect(speedArg.value).toBe(0.8);
    });

    it('rotates waypoints into the robot frame using startHeading', () => {
      // Robot starts facing +Y (90°). A waypoint at (0, 10) in table frame
      // is straight ahead of the robot ⇒ forward=10, left=0.
      const step = waypointsToSplineStep(
        [
          { id: 'a', x: 0, y: 0 },
          { id: 'b', x: 0, y: 10 },
        ],
        { startX: 0, startY: 0, startHeading: Math.PI / 2 }
      );
      const tuples = JSON.parse(
        String(step!.arguments.find((a) => a.name === 'waypoints')!.value)
      ) as number[][];
      expect(tuples[1][0]).toBeCloseTo(10, 6);
      expect(tuples[1][1]).toBeCloseTo(0, 6);
    });

    it('emits 3-tuples when explicit headings are requested', () => {
      const step = waypointsToSplineStep(
        [
          { id: 'a', x: 0, y: 0, headingDeg: 0 },
          { id: 'b', x: 5, y: 0, headingDeg: 90 },
        ],
        { ...baseOpts, useExplicitHeadings: true }
      );
      const tuples = JSON.parse(
        String(step!.arguments.find((a) => a.name === 'waypoints')!.value)
      ) as number[][];
      expect(tuples[0]).toHaveLength(3);
      expect(tuples[1][2]).toBeCloseTo(90, 6);
    });

    it('formatStepForPreview summarizes a spline_path step', () => {
      const step = waypointsToSplineStep(
        [
          { id: 'a', x: 0, y: 0 },
          { id: 'b', x: 5, y: 5 },
          { id: 'c', x: 10, y: 0 },
        ],
        baseOpts
      );
      expect(formatStepForPreview(step!)).toBe('spline_path(3 pts, speed=0.8)');
    });
  });

});
