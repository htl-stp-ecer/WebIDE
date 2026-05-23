import type { ReplayFrame, ReplayHeader, ReplayObservation } from './localization-replay.service';

export interface ReplayRenderParams {
  /** Canvas X of table-coord (xCm, yCm). */
  tableToCanvasX: (xCm: number, yCm: number) => number;
  /** Canvas Y of table-coord (xCm, yCm). */
  tableToCanvasY: (xCm: number, yCm: number) => number;
}

/** Pose ([x_m, y_m, theta_rad]) → table coords in cm. */
export function poseToTableCm(pose: [number, number, number]): { x: number; y: number; theta: number } {
  return { x: pose[0] * 100, y: pose[1] * 100, theta: pose[2] };
}

/** Draw the particle cloud — small dots with alpha proportional to weight. */
export function renderParticleCloud(
  ctx: CanvasRenderingContext2D,
  frame: ReplayFrame,
  params: ReplayRenderParams,
): void {
  const particles = frame.particles;
  if (!particles || particles.length === 0) return;

  let maxWeight = 0;
  for (const p of particles) {
    if (p[3] > maxWeight) maxWeight = p[3];
  }
  if (maxWeight <= 0) maxWeight = 1;

  ctx.save();
  ctx.fillStyle = '#38bdf8';
  for (const p of particles) {
    const xCm = p[0] * 100;
    const yCm = p[1] * 100;
    const w = p[3];
    const alpha = Math.max(0.12, Math.min(1, 0.15 + 0.85 * (w / maxWeight)));
    ctx.globalAlpha = alpha;
    const cx = params.tableToCanvasX(xCm, yCm);
    const cy = params.tableToCanvasY(xCm, yCm);
    ctx.beginPath();
    ctx.arc(cx, cy, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Draw the pose-estimate trail up to (and including) the current frame. */
export function renderReplayTrail(
  ctx: CanvasRenderingContext2D,
  poses: [number, number, number][],
  params: ReplayRenderParams,
): void {
  if (poses.length < 2) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < poses.length; i++) {
    const p = poses[i];
    const xCm = p[0] * 100;
    const yCm = p[1] * 100;
    const cx = params.tableToCanvasX(xCm, yCm);
    const cy = params.tableToCanvasY(xCm, yCm);
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw observation markers at the world position of each sensor.
 * Walls render red, lines green. Sensor frame: forward along robot +X, strafe
 * along robot +Y (matches renderRobotAtCenter convention).
 */
export function renderSensorHits(
  ctx: CanvasRenderingContext2D,
  frame: ReplayFrame,
  params: ReplayRenderParams,
  _header: ReplayHeader | null,
): void {
  if (!frame.observations || frame.observations.length === 0) return;
  const pose = poseToTableCm(frame.pose);
  const cos = Math.cos(pose.theta);
  const sin = Math.sin(pose.theta);

  for (const obs of frame.observations) {
    if (!obs.detected) continue;
    const [forwardCm, strafeCm] = obs.sensor_offset_cm ?? [0, 0];
    // Rotate sensor offset into world frame.
    const worldXCm = pose.x + cos * forwardCm - sin * strafeCm;
    const worldYCm = pose.y + sin * forwardCm + cos * strafeCm;
    const cx = params.tableToCanvasX(worldXCm, worldYCm);
    const cy = params.tableToCanvasY(worldXCm, worldYCm);
    drawCross(ctx, cx, cy, obs.surface_kind === 'wall' ? '#ef4444' : '#22c55e');
  }
}

function drawCross(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string): void {
  const r = 5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r);
  ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx + r, cy - r);
  ctx.lineTo(cx - r, cy + r);
  ctx.stroke();
  ctx.restore();
}

/** Format a t_ns value (relative to recording start) as "mm:ss.sss". */
export function formatTns(tNs: number): string {
  const totalMs = Math.max(0, tNs / 1_000_000);
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = (totalMs % 60_000) / 1000;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toFixed(3).padStart(6, '0')}`;
}
