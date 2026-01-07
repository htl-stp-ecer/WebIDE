import { MenuItem } from 'primeng/api';

interface Point {
  clientX: number;
  clientY: number;
}

export class ContextMenuState {
  items: MenuItem[] = [];
  nodeItems: MenuItem[] = [];
  commentItems: MenuItem[] = [];
  groupItems: MenuItem[] = [];
  canvasItems: MenuItem[] = [];
  connectionItems: MenuItem[] = [];
  selectedNodeId = '';
  selectedCommentId = '';
  selectedGroupId = '';
  selectedConnectionId = '';
  eventPosition: Point | null = null;
  readonly commentDrafts = new Map<string, string>();

  setItems(items: MenuItem[]): void {
    this.items = [...items];
  }

  selectNode(nodeId: string, point?: Point): void {
    this.selectedNodeId = nodeId;
    this.selectedCommentId = '';
    this.selectedGroupId = '';
    this.selectedConnectionId = '';
    this.eventPosition = point ?? null;
  }

  selectComment(commentId: string, point?: Point): void {
    this.selectedCommentId = commentId;
    this.selectedNodeId = '';
    this.selectedGroupId = '';
    this.selectedConnectionId = '';
    this.eventPosition = point ?? null;
  }

  selectGroup(groupId: string, point?: Point): void {
    this.selectedGroupId = groupId;
    this.selectedNodeId = '';
    this.selectedCommentId = '';
    this.selectedConnectionId = '';
    this.eventPosition = point ?? null;
  }

  selectConnection(connectionId: string, point?: Point): void {
    this.selectedConnectionId = connectionId;
    this.selectedNodeId = '';
    this.selectedCommentId = '';
    this.selectedGroupId = '';
    this.eventPosition = point ?? null;
  }

  resetSelection(): void {
    this.selectedNodeId = '';
    this.selectedCommentId = '';
    this.selectedGroupId = '';
    this.selectedConnectionId = '';
    this.eventPosition = null;
  }
}
