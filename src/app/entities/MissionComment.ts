export interface MissionComment {
  id: string;
  text: string;
  position?: {
    x: number;
    y: number;
  };
  before_path?: string | null;
  after_path?: string | null;
}
