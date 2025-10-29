import { MenuItem } from 'primeng/api';

interface Point {
  clientX: number;
  clientY: number;
}

export class ContextMenuState {
  items: MenuItem[] = [];
  nodeItems: MenuItem[] = [];
  commentItems: MenuItem[] = [];
  canvasItems: MenuItem[] = [];
  connectionItems: MenuItem[] = [];
  selectedNodeId = '';
  selectedCommentId = '';
  selectedConnectionId = '';
  eventPosition: Point | null = null;
  readonly commentDrafts = new Map<string, string>();

  setItems(items: MenuItem[]): void {
    this.items = [...items];
  }

  selectNode(nodeId: string, point?: Point): void {
    this.selectedNodeId = nodeId;
    this.selectedCommentId = '';
    this.selectedConnectionId = '';
    this.eventPosition = point ?? null;
  }

  selectComment(commentId: string, point?: Point): void {
    this.selectedCommentId = commentId;
    this.selectedNodeId = '';
    this.selectedConnectionId = '';
    this.eventPosition = point ?? null;
  }

  selectConnection(connectionId: string, point?: Point): void {
    this.selectedConnectionId = connectionId;
    this.selectedNodeId = '';
    this.selectedCommentId = '';
    this.eventPosition = point ?? null;
  }

  resetSelection(): void {
    this.selectedNodeId = '';
    this.selectedCommentId = '';
    this.selectedConnectionId = '';
    this.eventPosition = null;
  }
}
