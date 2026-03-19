import { optimizeWaypointsToSteps } from './path-optimizer';
import { createPose, createSensorConfig } from '../models';

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
});
