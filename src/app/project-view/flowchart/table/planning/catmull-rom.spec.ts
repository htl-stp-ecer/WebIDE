import { describe, expect, it } from 'vitest';
import { sampleCatmullRom, tangentsAtWaypoints, type Vec2 } from './catmull-rom';

describe('sampleCatmullRom', () => {
  it('returns empty for fewer than 2 waypoints', () => {
    expect(sampleCatmullRom([])).toEqual([]);
    expect(sampleCatmullRom([{ x: 0, y: 0 }])).toEqual([]);
  });

  it('produces a straight line for exactly 2 waypoints', () => {
    const pts = sampleCatmullRom(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      4
    );
    expect(pts.length).toBe(5);
    for (const p of pts) {
      expect(p.y).toBeCloseTo(0, 6);
    }
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1].x).toBeCloseTo(10, 6);
  });

  it('passes through every control point', () => {
    const wps: Vec2[] = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 0 },
      { x: 15, y: 8 },
    ];
    const pts = sampleCatmullRom(wps, 30);
    for (const wp of wps) {
      const nearest = pts.reduce(
        (best, p) => {
          const d = Math.hypot(p.x - wp.x, p.y - wp.y);
          return d < best ? d : best;
        },
        Number.POSITIVE_INFINITY
      );
      expect(nearest).toBeLessThan(0.05);
    }
  });

  it('produces a smooth curve (small consecutive distances)', () => {
    const wps: Vec2[] = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 0 },
    ];
    const pts = sampleCatmullRom(wps, 30);
    let maxStep = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      maxStep = Math.max(maxStep, d);
    }
    // Each step should be well under the chord between waypoints.
    expect(maxStep).toBeLessThan(2);
  });
});

describe('tangentsAtWaypoints', () => {
  it('returns unit vectors for every waypoint', () => {
    const wps: Vec2[] = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 0 },
    ];
    const tans = tangentsAtWaypoints(wps);
    expect(tans).toHaveLength(3);
    for (const t of tans) {
      expect(Math.hypot(t.x, t.y)).toBeCloseTo(1, 6);
    }
  });

  it('produces horizontal tangent for collinear horizontal waypoints', () => {
    const tans = tangentsAtWaypoints([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]);
    for (const t of tans) {
      expect(t.x).toBeCloseTo(1, 4);
      expect(t.y).toBeCloseTo(0, 4);
    }
  });
});
