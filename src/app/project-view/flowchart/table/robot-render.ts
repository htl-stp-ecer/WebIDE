export interface RobotCanvasConfig {
  widthCm: number;
  lengthCm: number;
  rotationCenterForwardCm: number;
  rotationCenterStrafeCm: number;
}

export interface RobotCanvasSensor {
  forwardCm: number;
  strafeCm: number;
  color: string;
  selected?: boolean;
}

export interface RobotCanvasOptions {
  bodyFill: string;
  bodyStroke: string;
  arrowFill: string;
  rotationCenterFill: string;
  geometricCenterFill: string;
  dashed: boolean;
  sensors?: RobotCanvasSensor[];
}

/**
 * Draw a robot on a canvas context.
 * (cx, cy) is the canvas position of the robot's rotation center.
 * theta=0 means forward faces right; theta=π/2 means forward faces up.
 */
export function renderRobotAtCenter(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  theta: number,
  config: RobotCanvasConfig,
  scaleX: number,
  scaleY: number,
  options: RobotCanvasOptions
): void {
  const robotWidthPx = config.widthCm * scaleX;
  const robotLengthPx = config.lengthCm * scaleY;
  const rcOffsetForwardPx = config.rotationCenterForwardCm * scaleX;
  const rcOffsetStrafePx = config.rotationCenterStrafeCm * scaleY;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-theta);

  const bodyCenterX = -rcOffsetForwardPx;
  const bodyCenterY = rcOffsetStrafePx;
  const halfL = robotLengthPx / 2;
  const halfW = robotWidthPx / 2;

  // Wheels (4-corner mecanum style)
  const wheelL = robotLengthPx * 0.35;
  const wheelW = Math.max(4, robotWidthPx * 0.14);
  const wheelXOff = robotLengthPx * 0.28;
  const wheelRadius = Math.min(2, wheelW * 0.25);
  const wheelFill = options.dashed ? 'rgba(30, 41, 59, 0.45)' : '#1e293b';
  const wheelStroke = options.dashed ? 'rgba(51, 65, 85, 0.35)' : '#334155';

  ctx.fillStyle = wheelFill;
  ctx.strokeStyle = wheelStroke;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);

  const wheelCorners = [
    { x: bodyCenterX + wheelXOff - wheelL / 2, y: bodyCenterY - halfW - wheelW, rollerDir: 1 },
    { x: bodyCenterX + wheelXOff - wheelL / 2, y: bodyCenterY + halfW,           rollerDir: -1 },
    { x: bodyCenterX - wheelXOff - wheelL / 2, y: bodyCenterY - halfW - wheelW, rollerDir: -1 },
    { x: bodyCenterX - wheelXOff - wheelL / 2, y: bodyCenterY + halfW,           rollerDir: 1 },
  ];

  for (const w of wheelCorners) {
    ctx.beginPath();
    ctx.roundRect(w.x, w.y, wheelL, wheelW, wheelRadius);
    ctx.fill();
    ctx.stroke();
    if (!options.dashed) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(w.x, w.y, wheelL, wheelW, wheelRadius);
      ctx.clip();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
      ctx.lineWidth = 1.5;
      const wcx = w.x + wheelL / 2;
      const wcy = w.y + wheelW / 2;
      const stripeLen = Math.max(wheelL, wheelW) * 0.8;
      const angle = w.rollerDir * Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(wcx - Math.cos(angle) * stripeLen / 2, wcy - Math.sin(angle) * stripeLen / 2);
      ctx.lineTo(wcx + Math.cos(angle) * stripeLen / 2, wcy + Math.sin(angle) * stripeLen / 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Robot body
  const bodyRadius = Math.min(robotLengthPx * 0.1, robotWidthPx * 0.1, 10);
  ctx.fillStyle = options.bodyFill;
  ctx.strokeStyle = options.bodyStroke;
  ctx.lineWidth = 2;
  if (options.dashed) ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.roundRect(bodyCenterX - halfL, bodyCenterY - halfW, robotLengthPx, robotWidthPx, bodyRadius);
  ctx.fill();
  ctx.stroke();
  if (options.dashed) ctx.setLineDash([]);

  // Forward arrow
  ctx.fillStyle = options.arrowFill;
  ctx.beginPath();
  const arrowTipX = bodyCenterX + halfL + 2;
  ctx.moveTo(arrowTipX, bodyCenterY);
  ctx.lineTo(arrowTipX - 10, bodyCenterY - 6);
  ctx.lineTo(arrowTipX - 10, bodyCenterY + 6);
  ctx.closePath();
  ctx.fill();

  // Rotation center marker
  ctx.fillStyle = options.rotationCenterFill;
  ctx.beginPath();
  ctx.arc(0, 0, 4, 0, Math.PI * 2);
  ctx.fill();

  // Geometric center marker (only when RC is offset)
  if (config.rotationCenterForwardCm !== 0 || config.rotationCenterStrafeCm !== 0) {
    ctx.fillStyle = options.geometricCenterFill;
    ctx.beginPath();
    ctx.arc(bodyCenterX, bodyCenterY, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Sensors
  if (options.sensors) {
    for (const sensor of options.sensors) {
      const sx = bodyCenterX + sensor.forwardCm * scaleX;
      const sy = bodyCenterY - sensor.strafeCm * scaleY;
      ctx.fillStyle = sensor.color;
      ctx.beginPath();
      ctx.arc(sx, sy, sensor.selected ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      if (sensor.selected) {
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  ctx.restore();
}
