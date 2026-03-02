import {
  closestLineNormalAngle,
  findClosestLineSegment,
  linePerpendicularScore,
  lineupPerpThreshold,
  lineupProximityCm,
} from './line-utils';
import { LineSegmentCm } from '../services';

describe('line-utils', () => {
  const segments: LineSegmentCm[] = [
    { startX: 0, startY: 0, endX: 10, endY: 0, isDiagonal: false },
    { startX: 8, startY: -5, endX: 8, endY: 5, isDiagonal: false },
  ];

  it('finds the nearest line segment and projection point', () => {
    const closest = findClosestLineSegment(segments, 9, 2);

    expect(closest).not.toBeNull();
    expect(closest?.segment).toEqual(segments[1]);
    expect(closest?.closestX).toBeCloseTo(8, 10);
    expect(closest?.closestY).toBeCloseTo(2, 10);
    expect(closest?.distance).toBeCloseTo(1, 10);
  });

  it('returns null when no line segments are available', () => {
    expect(findClosestLineSegment([], 1, 1)).toBeNull();
  });

  it('computes perpendicularity score from heading vs line angle', () => {
    expect(linePerpendicularScore(0, 0)).toBeCloseTo(0, 10);
    expect(linePerpendicularScore(Math.PI / 2, 0)).toBeCloseTo(1, 10);
  });

  it('returns the normal angle that is closest to heading direction', () => {
    const chosen = closestLineNormalAngle(0, Math.PI / 2);
    expect(chosen).toBeCloseTo(0, 10);
  });


  it('chooses the opposite normal when heading is closer to opposite direction', () => {
    const chosen = closestLineNormalAngle(Math.PI, Math.PI / 2);
    expect(chosen).toBeCloseTo(Math.PI, 10);
  });

  it('maps lineup thresholds to expected tuning ranges', () => {
    expect(lineupProximityCm(0)).toBeCloseTo(5, 10);
    expect(lineupProximityCm(1)).toBeCloseTo(3, 10);
    expect(lineupPerpThreshold(-1)).toBeCloseTo(0.1, 10);
    expect(lineupPerpThreshold(1)).toBeCloseTo(0.6, 10);
  });

  it('handles degenerate segments and threshold clamping above range', () => {
    const degenerate = [{ startX: 2, startY: 2, endX: 2, endY: 2, isDiagonal: false }];
    const closest = findClosestLineSegment(degenerate, 5, 6);

    expect(closest?.closestX).toBe(2);
    expect(closest?.closestY).toBe(2);
    expect(lineupProximityCm(2)).toBeCloseTo(3, 10);
    expect(lineupPerpThreshold(2)).toBeCloseTo(0.6, 10);
  });

});
