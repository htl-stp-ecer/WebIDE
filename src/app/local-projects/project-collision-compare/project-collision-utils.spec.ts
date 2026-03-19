import { createPose, Pose2D } from '../../project-view/flowchart/table/models';
import { PathWithSegments } from '../../project-view/flowchart/table/physics';
import { MapConfig, RobotConfig } from '../../project-view/flowchart/table/services';
import { buildTimedPlannedPathFromSimulation } from '../../project-view/flowchart/table/simulation-path';
import {
  buildTimedPathFromFrames,
  detectProjectCollisions,
  doRobotFootprintsOverlap,
  interpolatePoseAtTime,
  ProjectComparisonData,
  ProjectMapGeometry,
} from './project-collision-utils';

const robotConfig: RobotConfig = {
  widthCm: 20,
  lengthCm: 20,
  rotationCenterForwardCm: 0,
  rotationCenterStrafeCm: 0,
};

const emptyMapConfig: MapConfig = {
  widthCm: 200,
  heightCm: 100,
  pixelsPerCm: 1,
};

const emptyMap: ProjectMapGeometry = {
  config: emptyMapConfig,
  lineSegmentsCm: [],
  wallSegmentsCm: [],
  isLoaded: false,
  isOnBlackLine: () => false,
};

describe('project collision utils', () => {
  it('detects when two robot footprints overlap', () => {
    expect(doRobotFootprintsOverlap(createPose(50, 50, 0), robotConfig, createPose(58, 50, 0), robotConfig)).toBe(true);
    expect(doRobotFootprintsOverlap(createPose(50, 50, 0), robotConfig, createPose(90, 50, 0), robotConfig)).toBe(false);
  });

  it('interpolates a timed path across mission duration', () => {
    const adjusted: PathWithSegments = {
      poses: [createPose(0, 0, 0), createPose(20, 0, 0)],
      segments: [0],
    };
    const timed = buildTimedPathFromFrames(
      [
        { timeMs: 0, poseIndex: 0 },
        { timeMs: 1000, poseIndex: 1 },
      ],
      adjusted,
      2
    );

    const halfway = interpolatePoseAtTime(timed, 500);
    expect(halfway?.x).toBeCloseTo(10, 5);
    expect(halfway?.y).toBeCloseTo(0, 5);
  });

  it('keeps backend step durations when building timed simulation frames', () => {
    const detail = buildTimedPlannedPathFromSimulation(
      createPose(0, 0, 0),
      {
        name: 'MissionA',
        is_setup: false,
        is_shutdown: false,
        order: 0,
        total_duration_ms: 1000,
        total_delta: { forward: 0.1, strafe: 0, angular: 0 },
        steps: [
          {
            path: [1],
            function_name: 'drive_forward',
            step_type: 'step',
            average_duration_ms: 200,
            duration_stddev_ms: 10,
            delta: { forward: 0.02, strafe: 0, angular: 0 },
          },
          {
            path: [2],
            function_name: 'drive_forward',
            step_type: 'step',
            average_duration_ms: 800,
            duration_stddev_ms: 10,
            delta: { forward: 0.08, strafe: 0, angular: 0 },
          },
        ],
      }
    );

    expect(detail.frames.map(frame => frame.timeMs)).toEqual([0, 200, 1000]);
    expect(detail.poses[1].x).toBeCloseTo(2, 5);
    expect(detail.poses[2].x).toBeCloseTo(10, 5);
  });

  it('reports one collision event for a continuous overlap window', () => {
    const leftProject = createProjectComparison('left', 'Left', [
      { timeMs: 0, pose: createPose(30, 50, 0) },
      { timeMs: 1000, pose: createPose(60, 50, 0) },
    ]);
    const rightProject = createProjectComparison('right', 'Right', [
      { timeMs: 0, pose: createPose(90, 50, 180) },
      { timeMs: 1000, pose: createPose(60, 50, 180) },
    ]);

    const collisions = detectProjectCollisions([leftProject, rightProject], 100);

    expect(collisions.length).toBe(1);
    expect(collisions[0].projectAUuid).toBe('left');
    expect(collisions[0].projectBUuid).toBe('right');
    expect(collisions[0].timeMs).toBeGreaterThan(500);
    expect(collisions[0].timeMs).toBeLessThanOrEqual(800);
  });
});

function createProjectComparison(
  projectUuid: string,
  projectName: string,
  frames: { timeMs: number; pose: Pose2D }[]
): ProjectComparisonData {
  return {
    projectUuid,
    projectName,
    startPose: frames[0].pose,
    robotConfig,
    map: emptyMap,
    simulation: { missions: [] },
    plannedPath: frames.map(frame => frame.pose),
    missionRanges: [],
    timedPath: {
      frames,
      totalDurationMs: frames[frames.length - 1].timeMs,
    },
  };
}
