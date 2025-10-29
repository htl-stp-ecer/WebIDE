import type { Flowchart } from './flowchart';
import type { FlowOrientation } from './models';
import type { IPoint } from '@foblex/2d';
import type { FCreateConnectionEvent, FCreateNodeEvent, FNodeIntersectedWithConnections } from '@foblex/flow';
import { handleLoaded, startNodePosition } from './layout-handlers';
import { handleOrientationChange, isVerticalOrientation } from './orientation-handlers';
import { handleUndo, handleRedo } from './history-handlers';
import { handleNodeMoved } from './mission-handlers';
import { handleCreateNode, deleteNode as removeNode } from './node-handlers';
import { handleAddBreakpoint, handleAddConnection, handleNodeIntersected as handleSplitConnection } from './connection-handlers';
import {
  handleCanvasContextMenu,
  handleCommentRightClick,
  handleCommentTextChange,
  handleCommentFocus,
  handleCommentBlur,
  createCommentFromContextMenu,
  handleCommentPositionChanged,
  deleteComment as removeComment,
  focusCommentTextarea as focusCommentField,
  toCanvasPoint,
} from './comment-handlers';
import { isNodeCompleted, isConnectionCompleted, handleRun, handleStop } from './run-handlers';
import { handleSave } from './save-handlers';
import { handleNodeContextMenu, handleConnectionContextMenu } from './menu-handlers';

export interface FlowchartActions {
  onLoaded(): void;
  onOrientationChange(value: FlowOrientation | null): void;
  isVertical(): boolean;
  startNodePosition(): { x: number; y: number };
  undo(): void;
  redo(): void;
  onNodeMoved(id: string, pos: IPoint): void;
  onCreateNode(event: FCreateNodeEvent): void;
  addConnection(event: FCreateConnectionEvent): void;
  onNodeIntersected(event: FNodeIntersectedWithConnections): void;
  onConnectionRightClick(event: MouseEvent, connectionId: string): void;
  onCanvasContextMenu(event: MouseEvent): void;
  onCommentRightClick(event: MouseEvent, id: string): void;
  onCommentTextChange(id: string, value: string): void;
  onCommentFocus(id: string): void;
  onCommentBlur(id: string): void;
  createCommentFromContextMenu(): void;
  onCommentPositionChanged(id: string, pos: IPoint): void;
  deleteComment(): void;
  focusCommentTextarea(id: string): void;
  onRightClick(event: MouseEvent, nodeId: string): void;
  addBreakpointToConnection(): void;
  deleteNode(): void;
  isNodeCompleted(id: string): boolean;
  isConnectionCompleted(id: string): boolean;
  toCanvasPoint(point: { clientX: number; clientY: number }): IPoint;
  onSave(): void;
  onRun(mode: 'normal' | 'debug'): void;
  stopRun(): void;
}

export function createFlowchartActions(flow: Flowchart): FlowchartActions {
  return {
    onLoaded: () => handleLoaded(flow),
    onOrientationChange: value => handleOrientationChange(flow, value),
    isVertical: () => isVerticalOrientation(flow),
    startNodePosition: () => startNodePosition(flow),
    undo: () => handleUndo(flow),
    redo: () => handleRedo(flow),
    onNodeMoved: (id, pos) => handleNodeMoved(flow, id, pos),
    onCreateNode: event => handleCreateNode(flow, event),
    addConnection: event => handleAddConnection(flow, event),
    onNodeIntersected: event => handleSplitConnection(flow, event),
    onConnectionRightClick: (event, connectionId) => handleConnectionContextMenu(flow, event, connectionId),
    onCanvasContextMenu: event => handleCanvasContextMenu(flow, event),
    onCommentRightClick: (event, id) => handleCommentRightClick(flow, event, id),
    onCommentTextChange: (id, value) => handleCommentTextChange(flow, id, value),
    onCommentFocus: id => handleCommentFocus(flow, id),
    onCommentBlur: id => handleCommentBlur(flow, id),
    createCommentFromContextMenu: () => createCommentFromContextMenu(flow),
    onCommentPositionChanged: (id, pos) => handleCommentPositionChanged(flow, id, pos),
    deleteComment: () => removeComment(flow),
    focusCommentTextarea: id => focusCommentField(flow, id),
    onRightClick: (event, nodeId) => handleNodeContextMenu(flow, event, nodeId),
    addBreakpointToConnection: () => handleAddBreakpoint(flow),
    deleteNode: () => removeNode(flow),
    isNodeCompleted: id => isNodeCompleted(flow, id),
    isConnectionCompleted: id => isConnectionCompleted(flow, id),
    toCanvasPoint: point => toCanvasPoint(flow, point),
    onSave: () => handleSave(flow),
    onRun: mode => handleRun(flow, mode),
    stopRun: () => handleStop(flow),
  };
}
