import type { Flowchart } from './flowchart';

export function handleUndo(flow: Flowchart): void {
  if (!flow.canUndoSignal?.()) {
    return;
  }
  flow.historyManager.beginHistoryTraversal();
  flow.history.undo();
}

export function handleRedo(flow: Flowchart): void {
  if (!flow.canRedoSignal?.()) {
    return;
  }
  flow.historyManager.beginHistoryTraversal();
  flow.history.redo();
}
