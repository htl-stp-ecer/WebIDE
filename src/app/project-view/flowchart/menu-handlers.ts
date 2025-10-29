import type { Flowchart } from './flowchart';
import type { FlowOrientation } from './models';

export function refreshContextMenus(flow: Flowchart): void {
  const deleteLabel = flow.translate.instant('COMMON.DELETE');
  const commentLabel = translateLabel(flow, 'FLOWCHART.COMMENT', 'Comment');
  const addCommentLabel = translateLabel(flow, 'FLOWCHART.ADD_COMMENT', 'Add Comment');
  const addBreakpointLabel = translateLabel(flow, 'FLOWCHART.ADD_BREAKPOINT', 'Add Breakpoint');
  const placeholder = translateLabel(flow, 'FLOWCHART.COMMENT_PLACEHOLDER', 'Write a comment...');

  flow.contextMenu.nodeItems = [{
    label: deleteLabel,
    icon: 'pi pi-trash',
    command: () => flow.actions.deleteNode(),
  }];

  flow.contextMenu.commentItems = [{
    label: deleteLabel,
    icon: 'pi pi-trash',
    command: () => flow.actions.deleteComment(),
  }];

  flow.contextMenu.canvasItems = [{
    label: addCommentLabel,
    icon: 'pi pi-comment',
    command: () => flow.actions.createCommentFromContextMenu(),
  }];

  flow.contextMenu.connectionItems = [{
    label: addBreakpointLabel,
    icon: 'pi pi-circle-fill',
    command: () => flow.actions.addBreakpointToConnection(),
  }];

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
  event.preventDefault();
  event.stopPropagation();
  flow.contextMenu.selectNode(nodeId, { clientX: event.clientX, clientY: event.clientY });
  flow.contextMenu.setItems(flow.contextMenu.nodeItems);
  flow.cm.show(event);
}

export function handleConnectionContextMenu(flow: Flowchart, event: MouseEvent, connectionId: string): void {
  event.preventDefault();
  event.stopPropagation();
  flow.contextMenu.selectConnection(connectionId, { clientX: event.clientX, clientY: event.clientY });
  const isMissionConnection = flow.missionConnections().some(c => c.id === connectionId);
  const connection = flow.connections().find(c => c.id === connectionId);
  const items = flow.contextMenu.connectionItems.map(item => ({
    ...item,
    disabled: !isMissionConnection || !!connection?.hasBreakpoint,
  }));
  flow.contextMenu.setItems(items);
  flow.cm.show(event);
}

function translateLabel(flow: Flowchart, key: string, fallback: string): string {
  const translated = flow.translate.instant(key);
  return translated === key ? fallback : translated;
}
