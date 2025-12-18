export interface MissionGroup {
  id: string;
  title?: string;
  position?: {
    x: number;
    y: number;
  };
  size?: {
    width: number;
    height: number;
  };
  collapsed?: boolean;
  step_paths?: string[];
}

