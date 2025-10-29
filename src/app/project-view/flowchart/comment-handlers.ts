import type {Flowchart} from './flowchart';
import {IPoint} from '@foblex/2d';
import {generateGuid} from '@foblex/utils';
import {FlowComment, FlowNode} from './models';
import {handleConnectionContextMenu} from './menu-handlers';

function syncMissionComments(flow: Flowchart, comments: FlowComment[]): void {
  const mission = flow.missionState.currentMission();
  if (!mission) {
    return;
  }
  mission.comments = comments.map(comment => ({
    id: comment.id,
    text: comment.text,
    position: {x: comment.position.x, y: comment.position.y},
    before_path: comment.beforePath ?? null,
    after_path: comment.afterPath ?? null,
  }));
}

export function handleCanvasContextMenu(flow: Flowchart, event: MouseEvent): void {
  if ((event.target as HTMLElement | null)?.closest('.node, .comment-node')) {
    return;
  }
  const connectionId = findNearbyConnection(flow, event);
  if (connectionId) {
    handleConnectionContextMenu(flow, event, connectionId);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  flow.contextMenu.resetSelection();
  flow.contextMenu.eventPosition = { clientX: event.clientX, clientY: event.clientY };
  flow.contextMenu.setItems(flow.contextMenu.canvasItems);
  flow.cm.show(event);
}

const CONNECTION_HIT_PADDING = 16;

function findNearbyConnection(flow: Flowchart, event: MouseEvent): string | null {
  const offsets = [
    { dx: 0, dy: 0 },
    { dx: CONNECTION_HIT_PADDING, dy: 0 },
    { dx: -CONNECTION_HIT_PADDING, dy: 0 },
    { dx: 0, dy: CONNECTION_HIT_PADDING },
    { dx: 0, dy: -CONNECTION_HIT_PADDING },
    { dx: CONNECTION_HIT_PADDING, dy: CONNECTION_HIT_PADDING },
    { dx: -CONNECTION_HIT_PADDING, dy: CONNECTION_HIT_PADDING },
    { dx: CONNECTION_HIT_PADDING, dy: -CONNECTION_HIT_PADDING },
    { dx: -CONNECTION_HIT_PADDING, dy: -CONNECTION_HIT_PADDING },
  ];

  for (const offset of offsets) {
    const candidate = document.elementFromPoint(event.clientX + offset.dx, event.clientY + offset.dy) as HTMLElement | null;
    const connectionEl = candidate?.closest?.('f-connection[data-connection-id]');
    if (connectionEl) {
      const id = connectionEl.getAttribute('data-connection-id');
      if (id) return id;
    }
  }

  return null;
}
export function handleCommentRightClick(flow: Flowchart, event: MouseEvent, commentId: string): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('.comment-text')) {
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  flow.contextMenu.selectComment(commentId, { clientX: event.clientX, clientY: event.clientY });
  flow.contextMenu.setItems(flow.contextMenu.commentItems);
  flow.cm.show(event);
}
export function handleCommentTextChange(flow: Flowchart, commentId: string, text: string): void {
  const comments = flow.comments();
  const index = comments.findIndex(c => c.id === commentId);
  if (index === -1) {
    return;
  }
  const updated = comments.slice();
  updated[index] = { ...updated[index], text };
  flow.comments.set(updated);
  syncMissionComments(flow, updated);
}
export function handleCommentFocus(flow: Flowchart, commentId: string): void {
  const comment = flow.comments().find(c => c.id === commentId);
  if (comment) {
    flow.contextMenu.commentDrafts.set(commentId, comment.text);
  }
}
export function handleCommentBlur(flow: Flowchart, commentId: string): void {
  const initial = flow.contextMenu.commentDrafts.get(commentId);
  const comment = flow.comments().find(c => c.id === commentId);
  if (comment && initial !== undefined && initial !== comment.text) {
    flow.historyManager.recordHistory('edit-comment');
  }
  flow.contextMenu.commentDrafts.delete(commentId);
}
export function createCommentFromContextMenu(flow: Flowchart): void {
  const position = flow.contextMenu.eventPosition;
  if (!position) {
    return;
  }
  addComment(flow, toCanvasPoint(flow, position));
  flow.cm.hide();
  flow.contextMenu.eventPosition = null;
}
export function addComment(flow: Flowchart, point: IPoint): void {
  const id = `comment-${generateGuid()}`;
  const comment: FlowComment = {
    id,
    position: { x: point.x, y: point.y },
    text: '',
    beforePath: null,
    afterPath: null,
  };
  const updated = [...flow.comments(), comment];
  flow.comments.set(updated);
  syncMissionComments(flow, updated);
  flow.contextMenu.selectedCommentId = id;
  flow.historyManager.recordHistory('create-comment');
  focusCommentTextarea(flow, id);
}
export function handleCommentPositionChanged(flow: Flowchart, commentId: string, pos: IPoint): void {
  const comments = flow.comments();
  const index = comments.findIndex(c => c.id === commentId);
  if (index === -1) {
    return;
  }
  const updated = comments.slice();
  const withPosition: FlowComment = {
    ...updated[index],
    position: { x: pos.x, y: pos.y },
  };

  const stepNodes: FlowNode[] = flow.nodes().filter(n => Array.isArray(n.path) && n.path.length) as FlowNode[];
  const orientation = flow.orientation();
  const axis: 'x' | 'y' = orientation === 'horizontal' ? 'x' : 'y';
  const sortedNodes = stepNodes.slice().sort((a, b) => a.position[axis] - b.position[axis]);
  const commentCoord = pos[axis];

  let beforeNode: FlowNode | undefined;
  let afterNode: FlowNode | undefined;

  for (let i = 0; i < sortedNodes.length; i++) {
    const node = sortedNodes[i];
    const nodeCoord = node.position[axis];

    if (commentCoord < nodeCoord) {
      afterNode = node;
      if (i > 0) {
        beforeNode = sortedNodes[i - 1];
      }
      break;
    }

    const nextNode = sortedNodes[i + 1];
    if (!nextNode) {
      beforeNode = node;
      break;
    }

    const nextCoord = nextNode.position[axis];
    if (commentCoord >= nodeCoord && commentCoord < nextCoord) {
      beforeNode = node;
      afterNode = nextNode;
      break;
    }
  }

  if (!afterNode && sortedNodes.length) {
    if (commentCoord < sortedNodes[0].position[axis]) {
      afterNode = sortedNodes[0];
    } else {
      beforeNode = sortedNodes[sortedNodes.length - 1];
    }
  }

  const toPath = (node: FlowNode | undefined): string | null => {
    const path = node?.path;
    return path && path.length ? path.join('.') : null;
  };

  updated[index] = {
    ...withPosition,
    beforePath: toPath(beforeNode),
    afterPath: toPath(afterNode),
  };
  flow.comments.set(updated);
  syncMissionComments(flow, updated);
  flow.historyManager.recordHistory('move-comment');
}
export function deleteComment(flow: Flowchart): void {
  const id = flow.contextMenu.selectedCommentId;
  if (!id) {
    return;
  }
  const before = flow.comments().length;
  const updated = flow.comments().filter(c => c.id !== id);
  flow.comments.set(updated);
  flow.contextMenu.commentDrafts.delete(id);
  flow.contextMenu.selectedCommentId = '';
  if (flow.comments().length !== before) {
    syncMissionComments(flow, updated);
    flow.historyManager.recordHistory('delete-comment');
  }
}
export function focusCommentTextarea(flow: Flowchart, id: string): void {
  setTimeout(() => {
    const ref = flow.commentTextareas?.toArray().find(t => t.nativeElement.dataset['commentId'] === id);
    ref?.nativeElement.focus();
  }, 0);
}
export function toCanvasPoint(flow: Flowchart, point: { clientX: number; clientY: number }): IPoint {
  const canvas = flow.fCanvas();
  if (!canvas) {
    return { x: point.clientX, y: point.clientY };
  }

  const rect = canvas.hostElement.getBoundingClientRect();
  const localX = point.clientX - rect.left;
  const localY = point.clientY - rect.top;

  let transform = 'none';
  try {
    transform = getComputedStyle(canvas.hostElement).transform;
  } catch {
    /* ignore style lookup errors */
  }

  if (!transform || transform === 'none') {
    const scale = canvas.transform?.scale ?? 1;
    return { x: localX / scale, y: localY / scale };
  }

  const match = transform.match(/matrix\(([^)]+)\)/);
  if (match) {
    const parts = match[1].split(',').map(v => Number.parseFloat(v.trim()));
    if (parts.length >= 6 && !parts.some(Number.isNaN)) {
      const [a, b, c, d] = parts;
      const scaleX = Math.sqrt(a * a + b * b) || 1;
      const scaleY = Math.sqrt(c * c + d * d) || 1;
      return { x: localX / scaleX, y: localY / scaleY };
    }
  }

  if (transform.startsWith('matrix3d')) {
    const MatrixCtor: any = (window as any)?.DOMMatrix || (window as any)?.WebKitCSSMatrix || (window as any)?.MSCSSMatrix;
    if (MatrixCtor) {
      try {
        const matrix = new MatrixCtor(transform);
        const scaleX = Math.sqrt(matrix.m11 * matrix.m11 + matrix.m12 * matrix.m12) || 1;
        const scaleY = Math.sqrt(matrix.m21 * matrix.m21 + matrix.m22 * matrix.m22) || 1;
        return { x: localX / scaleX, y: localY / scaleY };
      } catch {
        /* ignore matrix errors */
      }
    }
  }

  const scale = canvas.transform?.scale ?? 1;
  return { x: localX / scale, y: localY / scale };
}
