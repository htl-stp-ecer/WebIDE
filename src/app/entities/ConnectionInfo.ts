interface DeviceSensorInfo {
  name: string;
  x_pct?: number;
  y_pct?: number;
  clearance_cm?: number;
}

interface DeviceCenterPoint {
  x_pct: number;
  y_pct: number;
}

interface ConnectionInfo {
  hostname: string;
  ip: string;
  battery_percent: number;
  width_cm?: number;
  length_cm?: number;
  sensors?: DeviceSensorInfo[];
  rotation_center?: DeviceCenterPoint;
}
