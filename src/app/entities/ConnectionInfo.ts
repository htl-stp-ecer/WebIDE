interface DeviceSensorInfo {
  name: string;
  x_cm?: number;  // Distance from left edge
  y_cm?: number;  // Distance from back edge (0=back, length=front)
  clearance_cm?: number;
}

interface DeviceCenterPoint {
  x_cm: number;  // Distance from left edge
  y_cm: number;  // Distance from back edge
}

interface DeviceStartPose {
  x_cm: number;
  y_cm: number;
  theta_deg: number;
}

interface ConnectionInfo {
  hostname: string;
  ip: string;
  battery_voltage_v?: number;
  battery_percent?: number;
  width_cm?: number;
  length_cm?: number;
  sensors?: DeviceSensorInfo[];
  rotation_center?: DeviceCenterPoint;
  start_pose?: DeviceStartPose;
  // Kinematics info (editable, from robot.drive.kinematics)
  drive_type?: string;
  track_width_m?: number;
  wheelbase_m?: number;
  wheel_radius_m?: number;
}
