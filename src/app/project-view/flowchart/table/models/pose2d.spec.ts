import {
  applyLocalDelta,
  createPose,
  forwardMove,
  getForward,
  lerpPose,
  normalizeAngle,
  rotate,
  strafe,
  thetaToDegrees,
} from './pose2d';

describe('pose2d utilities', () => {
  it('normalizes angles to [-pi, pi]', () => {
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 10);
    expect(normalizeAngle(-Math.PI * 3)).toBeCloseTo(-Math.PI, 10);
  });

  it('creates pose from degree heading', () => {
    const pose = createPose(10, 15, 270);
    expect(pose.x).toBe(10);
    expect(pose.y).toBe(15);
    expect(thetaToDegrees(pose.theta)).toBeCloseTo(-90, 10);
  });

  it('applies local deltas in robot frame', () => {
    const pose = createPose(0, 0, 90);
    const moved = applyLocalDelta(pose, 10, 2, Math.PI / 2);

    expect(moved.x).toBeCloseTo(-2, 10);
    expect(moved.y).toBeCloseTo(10, 10);
    expect(thetaToDegrees(moved.theta)).toBeCloseTo(180, 10);
  });

  it('supports forward move, strafe, and rotate operations', () => {
    const start = createPose(5, 5, 0);
    const forward = forwardMove(start, 8);
    const sideways = strafe(forward, 3);
    const turned = rotate(sideways, Math.PI / 2);

    expect(forward).toEqual({ x: 13, y: 5, theta: 0 });
    expect(sideways.x).toBeCloseTo(13, 10);
    expect(sideways.y).toBeCloseTo(8, 10);
    expect(thetaToDegrees(turned.theta)).toBeCloseTo(90, 10);
  });

  it('returns forward heading vector and interpolates between poses', () => {
    const a = createPose(0, 0, 0);
    const b = createPose(10, 20, 180);

    expect(getForward(a)).toEqual({ x: 1, y: 0 });

    const mid = lerpPose(a, b, 0.5);
    expect(mid.x).toBeCloseTo(5, 10);
    expect(mid.y).toBeCloseTo(10, 10);
    expect(Math.abs(thetaToDegrees(mid.theta))).toBeCloseTo(90, 10);
  });
});
