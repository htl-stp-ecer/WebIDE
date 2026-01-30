import type { Flowchart } from './flowchart';
import type { FlowOrientation } from './models';
import type { IPoint } from '@foblex/2d';
import type { FCreateConnectionEvent, FCreateNodeEvent, FDropToGroupEvent, FNodeIntersectedWithConnections } from '@foblex/flow';
import { handleLoaded, startNodePosition } from './layout-handlers';
import { handleOrientationChange, isVerticalOrientation } from './orientation-handlers';
import { handleUndo, handleRedo } from './history-handlers';
import { handleNodeMoved, handleAddPlannedSteps } from './mission-handlers';
import { MissionStep } from '../../entities/MissionStep';
import { handleCreateNode, deleteNode as removeNode } from './node-handlers';
import { handleArgumentChange } from './argument-handlers';
import { handleAddBreakpoint, handleAddConnection, handleNodeIntersected as handleSplitConnection, handleRemoveBreakpoint } from './connection-handlers';
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
import {
  createGroupFromContextMenu,
  deleteGroup as removeGroup,
  getNodeParentGroupId,
  getVisibleConnections,
  getVisibleNodes,
  handleDropToGroup,
  handleGroupPositionChanged,
  handleGroupRightClick,
  handleGroupSizeChanged,
  removeSelectedNodeFromGroups,
  toggleGroupCollapsed,
} from './group-handlers';
import { isNodeCompleted, isConnectionCompleted, handleRun, handleStop, handleContinueDebug } from './run-handlers';
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
  createGroupFromContextMenu(): void;
  onCommentPositionChanged(id: string, pos: IPoint): void;
  deleteComment(): void;
  onGroupRightClick(event: MouseEvent, id: string): void;
  onGroupPositionChanged(id: string, pos: IPoint): void;
  onGroupSizeChanged(id: string, rect: { width: number; height: number }): void;
  toggleGroupCollapsed(id: string): void;
  toggleSelectedGroupCollapsed(): void;
  deleteGroup(): void;
  onDropToGroup(event: FDropToGroupEvent): void;
  removeSelectedNodeFromGroup(): void;
  getNodeParentId(nodeId: string): string | null;
  visibleNodes(): import('./models').FlowNode[];
  visibleConnections(): import('./models').Connection[];
  focusCommentTextarea(id: string): void;
  onRightClick(event: MouseEvent, nodeId: string): void;
  addBreakpointToConnection(): void;
  removeBreakpointFromConnection(): void;
  deleteNode(): void;
  isNodeCompleted(id: string): boolean;
  isConnectionCompleted(id: string): boolean;
  toCanvasPoint(point: { clientX: number; clientY: number }): IPoint;
  onSave(): void;
  onRun(mode: 'normal' | 'debug'): void;
  stopRun(): void;
  continueDebug(): void;
  onArgumentChange(nodeId: string, argName: string, index: number, value: unknown): void;
  addPlannedSteps(steps: MissionStep[]): void;
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
    onCreateNode: event => {
      handleCreateNode(flow, event);
      const step = event.data as import('./models').Step | undefined;
      if (step) {
        flow.keybindingsService.trackStepUsage(step);
      }
    },
    addConnection: event => handleAddConnection(flow, event),
    onNodeIntersected: event => handleSplitConnection(flow, event),
    onConnectionRightClick: (event, connectionId) => handleConnectionContextMenu(flow, event, connectionId),
    onCanvasContextMenu: event => handleCanvasContextMenu(flow, event),
    onCommentRightClick: (event, id) => handleCommentRightClick(flow, event, id),
    onCommentTextChange: (id, value) => handleCommentTextChange(flow, id, value),
    onCommentFocus: id => handleCommentFocus(flow, id),
    onCommentBlur: id => handleCommentBlur(flow, id),
    createCommentFromContextMenu: () => createCommentFromContextMenu(flow),
    createGroupFromContextMenu: () => createGroupFromContextMenu(flow),
    onCommentPositionChanged: (id, pos) => handleCommentPositionChanged(flow, id, pos),
    deleteComment: () => removeComment(flow),
    onGroupRightClick: (event, id) => handleGroupRightClick(flow, event, id),
    onGroupPositionChanged: (id, pos) => handleGroupPositionChanged(flow, id, pos),
    onGroupSizeChanged: (id, rect) => handleGroupSizeChanged(flow, id, rect),
    toggleGroupCollapsed: id => toggleGroupCollapsed(flow, id),
    toggleSelectedGroupCollapsed: () => {
      const id = flow.contextMenu.selectedGroupId;
      if (id) toggleGroupCollapsed(flow, id);
    },
    deleteGroup: () => removeGroup(flow),
    onDropToGroup: event => handleDropToGroup(flow, event),
    removeSelectedNodeFromGroup: () => removeSelectedNodeFromGroups(flow),
    getNodeParentId: nodeId => {
      const node = flow.nodes().find(n => n.id === nodeId);
      return node ? getNodeParentGroupId(flow, node) : null;
    },
    visibleNodes: () => getVisibleNodes(flow),
    visibleConnections: () => getVisibleConnections(flow),
    focusCommentTextarea: id => focusCommentField(flow, id),
    onRightClick: (event, nodeId) => handleNodeContextMenu(flow, event, nodeId),
    addBreakpointToConnection: () => handleAddBreakpoint(flow),
    removeBreakpointFromConnection: () => handleRemoveBreakpoint(flow),
    deleteNode: () => removeNode(flow),
    isNodeCompleted: id => isNodeCompleted(flow, id),
    isConnectionCompleted: id => isConnectionCompleted(flow, id),
    toCanvasPoint: point => toCanvasPoint(flow, point),
    onSave: () => handleSave(flow),
    onRun: mode => handleRun(flow, mode),
    stopRun: () => handleStop(flow),
    continueDebug: () => handleContinueDebug(flow),
    onArgumentChange: (nodeId, argName, index, value) => handleArgumentChange(flow, nodeId, argName, index, value),
    addPlannedSteps: steps => handleAddPlannedSteps(flow, steps),
  };
}
