import type { Flowchart } from './flowchart';
import type { FlowOrientation } from './models';

export function refreshContextMenus(flow: Flowchart): void {
  const deleteLabel = flow.translate.instant('COMMON.DELETE');
  const commentLabel = translateLabel(flow, 'FLOWCHART.COMMENT', 'Comment');
  const addCommentLabel = translateLabel(flow, 'FLOWCHART.ADD_COMMENT', 'Add Comment');
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

function translateLabel(flow: Flowchart, key: string, fallback: string): string {
  const translated = flow.translate.instant(key);
  return translated === key ? fallback : translated;
}
