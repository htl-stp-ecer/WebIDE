/**
 * Centripetal Catmull-Rom spline (alpha = 0.5).
 *
 * Mirrors the math used by `libstp::motion::CatmullRomSpline` in raccoon-lib
 * so the on-screen preview matches what the robot will actually drive. Visual
 * sampling uses a uniform local parameter per segment — that's enough for a
 * smooth preview; the C++ side does proper arc-length reparameterization for
 * motion control, which the IDE does not need to replicate.
 *
 * Endpoint handling: the first and last control points are reflected to give
 * the curve natural tangents that pass through every waypoint.
 */

export interface Vec2 {
  x: number;
  y: number;
}

const EPS = 1e-12;

function dist(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function lerp(a: Vec2, b: Vec2, ta: number, tb: number, u: number): Vec2 {
  const denom = tb - ta;
  if (Math.abs(denom) < EPS) return { ...a };
  const alpha = (u - ta) / denom;
  return {
    x: (1 - alpha) * a.x + alpha * b.x,
    y: (1 - alpha) * a.y + alpha * b.y,
  };
}

/** Build the (N+2) augmented control-point array with reflected endpoints. */
function buildAugmented(points: Vec2[]): Vec2[] {
  if (points.length < 2) {
    throw new Error('Catmull-Rom requires at least 2 points');
  }
  const first = points[0];
  const second = points[1];
  const last = points[points.length - 1];
  const secondLast = points[points.length - 2];
  return [
    { x: 2 * first.x - second.x, y: 2 * first.y - second.y },
    ...points,
    { x: 2 * last.x - secondLast.x, y: 2 * last.y - secondLast.y },
  ];
}

/**
 * Evaluate one Catmull-Rom segment via Barry-Goldman with centripetal knots.
 *
 * @param P0..P3  Four consecutive control points.
 * @param t       Local parameter in [0, 1] across segment P1→P2.
 */
function evalSegment(P0: Vec2, P1: Vec2, P2: Vec2, P3: Vec2, t: number): Vec2 {
  const t0 = 0;
  const t1 = t0 + Math.sqrt(Math.max(dist(P0, P1), EPS));
  const t2 = t1 + Math.sqrt(Math.max(dist(P1, P2), EPS));
  const t3 = t2 + Math.sqrt(Math.max(dist(P2, P3), EPS));

  const u = t1 + t * (t2 - t1);

  const A1 = lerp(P0, P1, t0, t1, u);
  const A2 = lerp(P1, P2, t1, t2, u);
  const A3 = lerp(P2, P3, t2, t3, u);

  const B1 = lerp(A1, A2, t0, t2, u);
  const B2 = lerp(A2, A3, t1, t3, u);

  return lerp(B1, B2, t1, t2, u);
}

/**
 * Sample dense points along the spline through `waypoints` for rendering.
 *
 * @param waypoints           At least 2 control points.
 * @param samplesPerSegment   Curve resolution per segment (default 24).
 * @returns Ordered points covering the whole curve.
 */
export function sampleCatmullRom(waypoints: Vec2[], samplesPerSegment = 24): Vec2[] {
  if (waypoints.length < 2) return [];
  if (waypoints.length === 2) {
    // Degenerate: two points yield a straight line.
    const result: Vec2[] = [];
    for (let i = 0; i <= samplesPerSegment; i++) {
      const t = i / samplesPerSegment;
      result.push({
        x: waypoints[0].x + (waypoints[1].x - waypoints[0].x) * t,
        y: waypoints[0].y + (waypoints[1].y - waypoints[0].y) * t,
      });
    }
    return result;
  }

  const pts = buildAugmented(waypoints);
  const numSegments = pts.length - 3;
  const result: Vec2[] = [];

  for (let seg = 0; seg < numSegments; seg++) {
    const [P0, P1, P2, P3] = [pts[seg], pts[seg + 1], pts[seg + 2], pts[seg + 3]];
    const steps = seg === numSegments - 1 ? samplesPerSegment : samplesPerSegment - 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / samplesPerSegment;
      result.push(evalSegment(P0, P1, P2, P3, t));
    }
  }

  return result;
}

/**
 * Unit tangent at each control point of the spline.
 *
 * Tangents are derived from neighboring points using the same centripetal
 * parameterization, so they match the curve direction at the waypoint
 * (read-only — Catmull-Rom does not expose them for direct editing).
 *
 * @returns Array of unit-length tangents in the same order as `waypoints`.
 */
export function tangentsAtWaypoints(waypoints: Vec2[]): Vec2[] {
  if (waypoints.length < 2) return waypoints.map(() => ({ x: 1, y: 0 }));

  const pts = buildAugmented(waypoints);
  const tangents: Vec2[] = [];
  const h = 1e-4;

  for (let i = 0; i < waypoints.length; i++) {
    // The waypoint at index i corresponds to control point pts[i+1] (since
    // index 0 in pts is the virtual reflected start). Its segment is
    // (pts[i], pts[i+1], pts[i+2], pts[i+3]) evaluated at t=0, OR the
    // previous segment (pts[i-1], pts[i], pts[i+1], pts[i+2]) at t=1 — they
    // agree because Catmull-Rom is C¹. We pick whichever segment exists.
    const segIdx = i < pts.length - 3 ? i : i - 1;
    const tEval = i < pts.length - 3 ? 0 : 1;
    const P0 = pts[segIdx];
    const P1 = pts[segIdx + 1];
    const P2 = pts[segIdx + 2];
    const P3 = pts[segIdx + 3];

    const tLo = Math.max(0, tEval - h);
    const tHi = Math.min(1, tEval + h);
    const a = evalSegment(P0, P1, P2, P3, tLo);
    const b = evalSegment(P0, P1, P2, P3, tHi);

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const norm = Math.sqrt(dx * dx + dy * dy);
    if (norm < EPS) {
      tangents.push({ x: 1, y: 0 });
    } else {
      tangents.push({ x: dx / norm, y: dy / norm });
    }
  }
  return tangents;
}
