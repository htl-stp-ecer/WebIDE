type PointPayload = {
  x_cm?: number | null;
  y_cm?: number | null;
  x_pct?: number | null;
  y_pct?: number | null;
};

type SensorPayload = PointPayload & {
  name: string;
  clearance_cm?: number | null;
};

export type DeviceInfoPayload = Omit<ConnectionInfo, 'width_cm' | 'length_cm' | 'sensors' | 'rotation_center'> & {
  width_cm?: number | null;
  length_cm?: number | null;
  sensors?: SensorPayload[] | null;
  rotation_center?: PointPayload | null;
};

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function dimension(value: number | null | undefined): number | undefined {
  return finite(value) && value > 0 ? value : undefined;
}

function toDistance(cm: number | null | undefined, pct: number | null | undefined, size: number | undefined, reverse = false): number | undefined {
  if (finite(cm)) return cm;
  if (!finite(pct) || size === undefined) return undefined;
  return ((reverse ? 100 - pct : pct) / 100) * size;
}

/** Wombat percentages are measured from the front-left, and IDE distances from the back-left. */
export function normalizeDeviceInfo(info: DeviceInfoPayload): ConnectionInfo {
  const width = dimension(info.width_cm);
  const length = dimension(info.length_cm);
  const center = info.rotation_center;
  const x = toDistance(center?.x_cm, center?.x_pct, width);
  const y = toDistance(center?.y_cm, center?.y_pct, length, true);

  return {
    ...info,
    width_cm: width,
    length_cm: length,
    sensors: info.sensors?.map(sensor => ({
      name: sensor.name,
      x_cm: toDistance(sensor.x_cm, sensor.x_pct, width),
      y_cm: toDistance(sensor.y_cm, sensor.y_pct, length, true),
      clearance_cm: sensor.clearance_cm ?? undefined,
    })),
    rotation_center: x !== undefined && y !== undefined ? { x_cm: x, y_cm: y } : undefined,
  };
}

function toPercentage(cm: number, size: number | undefined, reverse = false): number {
  if (!finite(cm) || size === undefined) {
    throw new Error('Wombat coordinates require finite measurements and positive robot dimensions.');
  }
  const percentage = (cm / size) * 100;
  return reverse ? 100 - percentage : percentage;
}

export function toWombatSensor(sensor: DeviceSensorInfo, width?: number, length?: number) {
  return {
    name: sensor.name,
    x_pct: sensor.x_cm == null ? undefined : toPercentage(sensor.x_cm, width),
    y_pct: sensor.y_cm == null ? undefined : toPercentage(sensor.y_cm, length, true),
    clearance_cm: sensor.clearance_cm,
  };
}

export function toWombatCenter(center: DeviceCenterPoint, width?: number, length?: number) {
  return {
    x_pct: toPercentage(center.x_cm, width),
    y_pct: toPercentage(center.y_cm, length, true),
  };
}
