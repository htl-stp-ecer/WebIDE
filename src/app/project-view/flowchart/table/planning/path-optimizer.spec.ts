import { optimizeWaypointsToSteps } from './path-optimizer';
import { createPose, createSensorConfig, setSensor } from '../models';
import { simulateCommands } from './pathfinding';
import { FlowStepId, isClockwiseStepId, isCounterClockwiseStepId } from '../step-id';

describe('path-optimizer integration', () => {
  const baseContext = {
    lineSegments: [{ startX: 0, startY: 10, endX: 20, endY: 10, isDiagonal: false }],
    sensorConfig: createSensorConfig(),
    isOnBlackLine: () => false,
  };

  it('creates turn and drive steps for normal waypoint movement', () => {
    const steps = optimizeWaypointsToSteps(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 0, y: 12 },
      ],
      createPose(0, 0, 0),
      baseContext
    );

    expect(steps.map(step => step.function_name)).toEqual(['turn_ccw', 'drive_forward']);
    expect(steps[0].arguments[0].value).toBe(90);
    expect(steps[1].arguments[0].value).toBe(12);
  });

  it('creates follow_line step when waypoint requests follow behavior', () => {
    const steps = optimizeWaypointsToSteps(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 12, y: 0, lineup: true, lineSnapAction: 'follow', lineupLineIndex: 0 },
      ],
      createPose(0, 0, 0),
      baseContext
    );

    expect(steps.length).toBe(1);
    expect(steps[0].function_name).toBe('follow_line');
    expect(steps[0].arguments[0].value).toBe(12);
  });

  it('creates intersection-stopping follow_line when a crossing appears before the waypoint', () => {
    const steps = optimizeWaypointsToSteps(
      [
        { id: 'a', x: 0, y: 10 },
        { id: 'b', x: 20, y: 10, lineup: true, lineSnapAction: 'follow', lineupLineIndex: 0 },
      ],
      createPose(0, 10, 0),
      {
        ...baseContext,
        lineSegments: [
          { startX: 0, startY: 10, endX: 30, endY: 10, isDiagonal: false },
          { startX: 12, startY: 0, endX: 12, endY: 20, isDiagonal: false },
        ],
      }
    );

    expect(steps.length).toBe(1);
    expect(steps[0].function_name).toBe('follow_line');
    expect(steps[0].arguments.length).toBe(0);
  });

  it('plans the next waypoint from the crossing after intersection-stopping follow_line', () => {
    const sensorConfig = createSensorConfig();
    setSensor(sensorConfig, 0, 0, 1);
    setSensor(sensorConfig, 1, 0, -1);

    const steps = optimizeWaypointsToSteps(
      [
        { id: 'a', x: 0, y: 10 },
        { id: 'b', x: 20, y: 10, lineup: true, lineSnapAction: 'follow', lineupLineIndex: 0 },
        { id: 'c', x: 20, y: 5 },
      ],
      createPose(0, 10, 0),
      {
        lineSegments: [
          { startX: 0, startY: 10, endX: 30, endY: 10, isDiagonal: false },
          { startX: 12, startY: 0, endX: 12, endY: 20, isDiagonal: false },
        ],
        sensorConfig,
        isOnBlackLine: (x: number, y: number) =>
          (Math.abs(y - 10) <= 0.75 && x >= 0 && x <= 30) ||
          (Math.abs(x - 12) <= 0.75 && y >= 0 && y <= 20),
      }
    );

    expect(steps.length).toBe(3);
    expect(steps[0].function_name).toBe('follow_line');
    expect(steps[0].arguments.length).toBe(0);
    expect(steps[1].function_name).toBe('turn_cw');
    expect(Number(steps[1].arguments[0].value)).toBeLessThan(90);
    expect(steps[2].function_name).toBe('drive_forward');
  });

  it('creates drive_until_black when waypoint requests drive until behavior', () => {
    const steps = optimizeWaypointsToSteps(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 12, y: 0, lineup: true, lineSnapAction: 'drive_until', lineupLineIndex: 0 },
      ],
      createPose(0, 0, 0),
      {
        ...baseContext,
        sensorConfig: createSensorConfig(),
      }
    );

    expect(steps[steps.length - 1].function_name).toBe('drive_until_black');
    expect(steps.some(step => step.function_name === 'drive_forward')).toBe(true);
  });

  it('reaches forward-left waypoints consistently across headings on an empty map', () => {
    const context = {
      lineSegments: [],
      sensorConfig: createSensorConfig(),
      isOnBlackLine: () => false,
    };

    const cases = [
      { start: createPose(40, 40, 0), goal: { x: 30, y: 60 } },
      { start: createPose(40, 40, 90), goal: { x: 20, y: 30 } },
      { start: createPose(40, 40, 180), goal: { x: 50, y: 20 } },
      { start: createPose(40, 40, -90), goal: { x: 60, y: 50 } },
    ];

    for (const { start, goal } of cases) {
      const steps = optimizeWaypointsToSteps(
        [
          { id: 'start', x: start.x, y: start.y },
          { id: 'goal', x: goal.x, y: goal.y },
        ],
        start,
        context
      );

      const endPose = simulateCommands(start, steps);
      expect(endPose.x).toBeCloseTo(goal.x, 0);
      expect(endPose.y).toBeCloseTo(goal.y, 0);
    }
  });

  it('treats turn_ccw as counter-clockwise during simulation', () => {
    expect(isCounterClockwiseStepId(FlowStepId.TurnCcw)).toBe(true);
    expect(isClockwiseStepId(FlowStepId.TurnCcw)).toBe(false);

    const endPose = simulateCommands(createPose(0, 0, 0), [
      {
        step_type: FlowStepId.TurnCcw,
        function_name: FlowStepId.TurnCcw,
        arguments: [{ name: 'deg', value: 90, type: 'float' }],
        position: { x: 0, y: 0 },
        children: [],
      },
    ]);

    expect(endPose.theta).toBeCloseTo(Math.PI / 2, 10);
  });
});
