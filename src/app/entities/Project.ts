interface ProjectConnection {
  pi_address?: string;
  pi_port?: number;
  pi_user?: string;
  remote_path?: string | null;
  auto_connect?: boolean;
}

interface Project {
  name: string;
  uuid: string;
  connection?: ProjectConnection;
}
