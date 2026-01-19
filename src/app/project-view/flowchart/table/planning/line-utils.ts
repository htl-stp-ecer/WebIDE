import type { LineSegmentCm } from '../services';
import { normalizeAngle } from '../models';

export const DEFAULT_LINE_PROXIMITY_CM = 3;

export interface ClosestLineInfo {
  segment: LineSegmentCm;
  distance: number;
  closestX: number;
  closestY: number;
  angle: number;
}

export function findClosestLineSegment(
  segments: LineSegmentCm[],
  x: number,
  y: number
): ClosestLineInfo | null {
  if (!segments.length) return null;

  let best: ClosestLineInfo | null = null;
  for (const segment of segments) {
    const closest = closestPointOnSegment(
      x,
      y,
      segment.startX,
      segment.startY,
      segment.endX,
      segment.endY
    );
    const dx = x - closest.x;
    const dy = y - closest.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (!best || dist < best.distance) {
      best = {
        segment,
        distance: dist,
        closestX: closest.x,
        closestY: closest.y,
        angle: Math.atan2(segment.endY - segment.startY, segment.endX - segment.startX),
      };
    }
  }

  return best;
}

export function linePerpendicularScore(headingRad: number, lineAngleRad: number): number {
  return Math.abs(Math.sin(normalizeAngle(headingRad - lineAngleRad)));
}

export function closestLineNormalAngle(headingRad: number, lineAngleRad: number): number {
  const normal = normalizeAngle(lineAngleRad + Math.PI / 2);
  const opposite = normalizeAngle(normal + Math.PI);
  const diffNormal = Math.abs(normalizeAngle(headingRad - normal));
  const diffOpposite = Math.abs(normalizeAngle(headingRad - opposite));
  return diffNormal <= diffOpposite ? normal : opposite;
}

function closestPointOnSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return { x: x1, y: y1 };

  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return { x: x1 + t * dx, y: y1 + t * dy };
}
