import type { IFConnectionBuilderRequest, IFConnectionBuilderResponse } from '@foblex/flow';

/**
 * Simple two-segment "elbow" connection path builder.
 * Vertical mode: goes straight down to the target Y, then horizontally to the target X.
 * Horizontal mode: goes straight right to the target X, then vertically to the target Y.
 */
export class ElbowPathBuilder {
  handle(request: IFConnectionBuilderRequest): IFConnectionBuilderResponse {
    const { source, target, sourceSide } = request;
    const sx = source.x, sy = source.y;
    const tx = target.x, ty = target.y;

    const isVertical = sourceSide === 'bottom' || sourceSide === 'top';

    let bendX: number, bendY: number;
    if (isVertical) {
      // Go vertical first, then horizontal
      bendX = sx;
      bendY = ty;
    } else {
      // Go horizontal first, then vertical
      bendX = tx;
      bendY = sy;
    }

    // If source and target are aligned, just draw a straight line
    const isStraight = (isVertical && Math.abs(sx - tx) < 1) || (!isVertical && Math.abs(sy - ty) < 1);

    let path: string;
    if (isStraight) {
      path = `M ${sx} ${sy} L ${tx} ${ty}`;
    } else {
      path = `M ${sx} ${sy} L ${bendX} ${bendY} L ${tx} ${ty}`;
    }

    const midX = (sx + tx) / 2;
    const midY = (sy + ty) / 2;

    return {
      path,
      connectionCenter: { x: midX, y: midY },
      penultimatePoint: isStraight ? { x: sx, y: sy } : { x: bendX, y: bendY },
      secondPoint: isStraight ? { x: tx, y: ty } : { x: bendX, y: bendY },
    };
  }
}
