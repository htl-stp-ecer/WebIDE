import { Mission } from '../../../entities/Mission';
import { MissionSimulationData, ProjectSimulationData } from '../../../entities/Simulation';
import { buildPlannedPathFromMission, buildPlannedPathFromProjectSimulationWithMissionOverride, buildPlannedPathFromSimulation } from './simulation-path';
import { Pose2D } from './models';
import { FlowStepId } from './step-id';

describe('simulation-path live mission overrides', () => {
  const startPose: Pose2D = { x: 0, y: 0, theta: 0 };
  const lineupContext = {
    isOnBlackLine: (_xCm: number, yCm: number) => Math.abs(yCm) <= 1.2,
    lineSensors: [
      { index: 0, forwardCm: 0, strafeCm: 1 },
      { index: 1, forwardCm: 0, strafeCm: -1 },
    ],
    rotationCenterForwardCm: 0,
    rotationCenterStrafeCm: 0,
    maxDistanceCm: 100,
  };

  it('builds a local follow-line path from live mission steps', () => {
    const mission: Mission = {
      name: 'Mission A',
      is_setup: false,
      is_shutdown: false,
      order: 1,
      steps: [
        {
          step_type: FlowStepId.FollowLine,
          function_name: FlowStepId.FollowLine,
          arguments: [{ name: 'cm', value: 10, type: 'float' }],
          children: [],
        },
      ],
    };

    const path = buildPlannedPathFromMission(startPose, mission, { lineup: lineupContext });

    expect(path.length).toBeGreaterThan(2);
    expect(path[path.length - 1].x).toBeCloseTo(10, 4);
    expect(path[path.length - 1].y).toBeCloseTo(0, 4);
  });

  it('overrides cached simulation for the edited mission', () => {
    const simulation: ProjectSimulationData = {
      missions: [
        {
          name: 'Mission A',
          is_setup: false,
          is_shutdown: false,
          order: 1,
          steps: [
            {
              path: [1],
              function_name: FlowStepId.DriveForward,
              step_type: FlowStepId.DriveForward,
              average_duration_ms: 0,
              duration_stddev_ms: 0,
              delta: { forward: 0.3, strafe: 0, angular: 0 },
            },
          ],
          total_duration_ms: 0,
          total_delta: { forward: 0.3, strafe: 0, angular: 0 },
        },
        {
          name: 'Mission B',
          is_setup: false,
          is_shutdown: false,
          order: 2,
          steps: [],
          total_duration_ms: 0,
          total_delta: { forward: 0, strafe: 0, angular: 0 },
        },
      ],
    };
    const missionOverride: Mission = {
      name: 'Mission A',
      is_setup: false,
      is_shutdown: false,
      order: 1,
      steps: [
        {
          step_type: FlowStepId.FollowLine,
          function_name: FlowStepId.FollowLine,
          arguments: [{ name: 'cm', value: 10, type: 'float' }],
          children: [],
        },
      ],
    };

    const planned = buildPlannedPathFromProjectSimulationWithMissionOverride(
      startPose,
      simulation,
      missionOverride,
      { lineup: lineupContext }
    );

    const missionAEnd = planned.missionEndIndices[0];
    expect(planned.poses[missionAEnd].x).toBeCloseTo(10, 4);
    expect(planned.poses[planned.poses.length - 1].x).toBeCloseTo(10, 4);
    expect(planned.missionRanges[0]).toEqual(jasmine.objectContaining({ name: 'Mission A', order: 1 }));
  });

  it('uses distance_cm from simulation labels for follow_line steps', () => {
    const simulation: MissionSimulationData = {
      name: 'Mission A',
      is_setup: false,
      is_shutdown: false,
      order: 1,
      steps: [
        {
          path: [1],
          function_name: FlowStepId.FollowLine,
          step_type: FlowStepId.FollowLine,
          label: 'follow_line(left_sensor=front_left, right_sensor=front_right, distance_cm=10, kp=0.75)',
          average_duration_ms: 0,
          duration_stddev_ms: 0,
          delta: { forward: 0, strafe: 0, angular: 0 },
        },
      ],
      total_duration_ms: 0,
      total_delta: { forward: 0, strafe: 0, angular: 0 },
    };

    const path = buildPlannedPathFromSimulation(startPose, simulation, { lineup: lineupContext });

    expect(path.length).toBeGreaterThan(2);
    expect(path[path.length - 1].x).toBeCloseTo(10, 4);
    expect(path[path.length - 1].y).toBeCloseTo(0, 4);
  });
});
