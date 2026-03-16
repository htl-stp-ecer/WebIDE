import { buildCollisionWalls, checkRobotCollision } from './physics';
import { createPose } from './models';

describe('physics wall thickness', () => {
  const robotConfig = {
    widthCm: 4,
    lengthCm: 4,
    rotationCenterForwardCm: 0,
    rotationCenterStrafeCm: 0,
  };

  const mapConfig = {
    widthCm: 200,
    heightCm: 100,
    pixelsPerCm: 1,
  };

  it('treats thick walls as collision rectangles rather than centerlines', () => {
    const walls = buildCollisionWalls(
      [
        {
          startX: 20,
          startY: 50,
          endX: 120,
          endY: 50,
          thickness: 10,
        },
      ],
      mapConfig
    );

    expect(walls.length).toBe(8);
    expect(checkRobotCollision(createPose(60, 56, 0), robotConfig, walls)).toBeTrue();
    expect(checkRobotCollision(createPose(60, 70, 0), robotConfig, walls)).toBeFalse();
  });
});
