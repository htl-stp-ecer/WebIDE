interface WebSocketResponse {
  type: string;
  name?: string;
  index?: number;
  timeline_index?: number;
  parent_index?: number;
  path?: number[];
  line?: string;
  returncode?: number;
  state?: string;
  success?: boolean;
  [key: string]: unknown;
}
