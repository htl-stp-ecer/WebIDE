import type { Flowchart } from './flowchart';
import type { FlowOrientation } from './models';
import type { MenuItem } from 'primeng/api';

export function refreshContextMenus(flow: Flowchart): void {
  const deleteLabel = flow.translate.instant('COMMON.DELETE');
  const commentLabel = translateLabel(flow, 'FLOWCHART.COMMENT', 'Comment');
  const addCommentLabel = translateLabel(flow, 'FLOWCHART.ADD_COMMENT', 'Add Comment');
  const addGroupLabel = translateLabel(flow, 'FLOWCHART.ADD_GROUP', 'Add Group');
  const toggleGroupLabel = translateLabel(flow, 'FLOWCHART.TOGGLE_GROUP', 'Toggle Group');
  const removeFromGroupLabel = translateLabel(flow, 'FLOWCHART.REMOVE_FROM_GROUP', 'Remove from Group');
  const addBreakpointLabel = translateLabel(flow, 'FLOWCHART.ADD_BREAKPOINT', 'Add Breakpoint');
  const removeBreakpointLabel = translateLabel(flow, 'FLOWCHART.REMOVE_BREAKPOINT', 'Remove Breakpoint');
  const placeholder = translateLabel(flow, 'FLOWCHART.COMMENT_PLACEHOLDER', 'Write a comment...');

  flow.contextMenu.nodeItems = [{
    label: removeFromGroupLabel,
    icon: 'pi pi-times',
    command: () => flow.actions.removeSelectedNodeFromGroup(),
  }, {
    label: deleteLabel,
    icon: 'pi pi-trash',
    command: () => flow.actions.deleteNode(),
  }];

  flow.contextMenu.commentItems = [{
    label: deleteLabel,
    icon: 'pi pi-trash',
    command: () => flow.actions.deleteComment(),
  }];

  flow.contextMenu.groupItems = [
    {
      label: toggleGroupLabel,
      icon: 'pi pi-window-minimize',
      command: () => flow.actions.toggleSelectedGroupCollapsed(),
    },
    {
      label: deleteLabel,
      icon: 'pi pi-trash',
      command: () => flow.actions.deleteGroup(),
    },
  ];

  flow.contextMenu.canvasItems = [{
    label: addCommentLabel,
    icon: 'pi pi-comment',
    command: () => flow.actions.createCommentFromContextMenu(),
  }, {
    label: addGroupLabel,
    icon: 'pi pi-clone',
    command: () => flow.actions.createGroupFromContextMenu(),
  }];

  flow.contextMenu.connectionItems = [
    {
      label: addBreakpointLabel,
      icon: 'pi pi-circle-fill',
      command: () => flow.actions.addBreakpointToConnection(),
    },
    {
      label: removeBreakpointLabel,
      icon: 'pi pi-times',
      command: () => flow.actions.removeBreakpointFromConnection(),
    },
  ];

  flow.contextMenu.setItems(flow.contextMenu.nodeItems);
  flow.commentHeaderLabel = commentLabel;
  flow.commentPlaceholder = placeholder;
}

export function updateOrientationOptions(flow: Flowchart): void {
  flow.orientationOptions = [
    { label: translateLabel(flow, 'FLOWCHART.ORIENTATION_VERTICAL', 'Vertical'), value: 'vertical' as FlowOrientation },
    { label: translateLabel(flow, 'FLOWCHART.ORIENTATION_HORIZONTAL', 'Horizontal'), value: 'horizontal' as FlowOrientation },
  ];
}

export function handleNodeContextMenu(flow: Flowchart, event: MouseEvent, nodeId: string): void {
  if (flow.contextMenuOnPointerUp) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (flow.shouldSuppressContextMenu(event) || flow.consumeContextMenuSuppression()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  flow.contextMenu.selectNode(nodeId, { clientX: event.clientX, clientY: event.clientY });
  if (!flow.selectedNodeIds().has(nodeId)) {
    flow.selectedNodeIds.set(new Set([nodeId]));
  }
  const deleteLabel = flow.translate.instant('COMMON.DELETE');
  const removeFromGroupLabel = translateLabel(flow, 'FLOWCHART.REMOVE_FROM_GROUP', 'Remove from Group');
  const parentId = flow.actions.getNodeParentId(nodeId);
  const items: MenuItem[] = [];
  if (parentId) {
    items.push({
      label: removeFromGroupLabel,
      icon: 'pi pi-times',
      command: () => flow.actions.removeSelectedNodeFromGroup(),
    });
  }
  items.push({
    label: deleteLabel,
    icon: 'pi pi-trash',
    command: () => flow.actions.deleteNode(),
  });
  flow.contextMenu.setItems(items);
  flow.cm.show(event);
}

export function handleConnectionContextMenu(flow: Flowchart, event: MouseEvent, connectionId: string): void {
  if (connectionId.startsWith('collapsed-')) {
    return;
  }
  if (flow.contextMenuOnPointerUp) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (flow.shouldSuppressContextMenu(event) || flow.consumeContextMenuSuppression()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  flow.contextMenu.selectConnection(connectionId, { clientX: event.clientX, clientY: event.clientY });
  const isMissionConnection = flow.missionConnections().some(c => c.id === connectionId);
  const connection = flow.connections().find(c => c.id === connectionId);
  const [addItem, removeItem] = flow.contextMenu.connectionItems;
  const menu: MenuItem[] = [];
  if (addItem) {
    menu.push({
      ...addItem,
      disabled: !isMissionConnection || !!connection?.hasBreakpoint,
    });
  }
  if (removeItem) {
    menu.push({
      ...removeItem,
      disabled: !isMissionConnection || !connection?.hasBreakpoint,
    });
  }
  flow.contextMenu.setItems(menu);
  flow.cm.show(event);
}

function translateLabel(flow: Flowchart, key: string, fallback: string): string {
  const translated = flow.translate.instant(key);
  return translated === key ? fallback : translated;
}
