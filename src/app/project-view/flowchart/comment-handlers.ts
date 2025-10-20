import type { Flowchart } from './flowchart';
import { IPoint } from '@foblex/2d';
import { generateGuid } from '@foblex/utils';
import { FlowComment } from './models';

export function handleCanvasContextMenu(flow: Flowchart, event: MouseEvent): void {
  if ((event.target as HTMLElement | null)?.closest('.node, .comment-node')) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  flow.contextMenu.resetSelection();
  flow.contextMenu.eventPosition = { clientX: event.clientX, clientY: event.clientY };
  flow.contextMenu.setItems(flow.contextMenu.canvasItems);
  flow.cm.show(event);
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
  const comment: FlowComment = { id, position: { x: point.x, y: point.y }, text: '' };
  flow.comments.set([...flow.comments(), comment]);
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
  updated[index] = { ...updated[index], position: { x: pos.x, y: pos.y } };
  flow.comments.set(updated);
  flow.historyManager.recordHistory('move-comment');
}
export function deleteComment(flow: Flowchart): void {
  const id = flow.contextMenu.selectedCommentId;
  if (!id) {
    return;
  }
  const before = flow.comments().length;
  flow.comments.set(flow.comments().filter(c => c.id !== id));
  flow.contextMenu.commentDrafts.delete(id);
  flow.contextMenu.selectedCommentId = '';
  if (flow.comments().length !== before) {
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
