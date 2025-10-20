import { Mission } from '../../entities/Mission';
import { Connection, FlowComment, FlowNode } from './models';

export function cloneNodes(nodes: FlowNode[] | undefined): FlowNode[] {
  return clonePlain(nodes ?? []);
}

export function cloneConnections(connections: Connection[] | undefined): Connection[] {
  return clonePlain(connections ?? []);
}

export function cloneComments(comments: FlowComment[] | undefined): FlowComment[] {
  return clonePlain(comments ?? []);
}

export function cloneMission(mission: Mission | null): Mission | null {
  return mission ? clonePlain(mission) : null;
}

export function clonePlain<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
