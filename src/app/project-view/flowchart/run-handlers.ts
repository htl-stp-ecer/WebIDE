import type { Flowchart } from './flowchart';

export function isNodeCompleted(flow: Flowchart, nodeId: string): boolean {
  return flow.runManager.isNodeCompleted(nodeId);
}

export function isConnectionCompleted(flow: Flowchart, connectionId: string): boolean {
  return flow.runManager.isConnectionCompleted(connectionId);
}

export function handleRun(flow: Flowchart, mode: 'normal' | 'debug'): void {
  flow.runManager.onRun(mode);
}

export function handleStop(flow: Flowchart): void {
  flow.runManager.stopRun();
}

export function handleContinueDebug(flow: Flowchart): void {
  flow.runManager.onDebugContinue();
}
