import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { isType, mk } from './models';
import { containsStep, detachEverywhere, findNearestParallelAncestor, findParentAndIndex } from './mission-tree-utils';
import { ensureParallelAfter } from './mission-parallel-utils';

export function shouldAppendSequentially(mission: Mission, parent: MissionStep): boolean {
  if (!parent || (parent.children ?? []).length > 0) return false;

  const loc = findParentAndIndex(mission, parent);
  if (!loc) return true;

  const { parent: directParent, container, index } = loc;
  if (directParent && isType(directParent, 'parallel')) return true;
  return container[index + 1] === undefined;
}
export function attachChildSequentially(mission: Mission, parent: MissionStep, child: MissionStep): boolean {
  if (parent === child) return false;

  detachEverywhere(mission, child);
  parent.children ??= [];
  if (!parent.children.length) {
    parent.children.push(child);
    return true;
  }

  const first = parent.children[0];
  if (isType(first, 'seq')) {
    first.children ??= [];
    if (!first.children.includes(child)) first.children.push(child);
    return true;
  }

  const seq = mk('seq');
  seq.children = [...parent.children, child];
  parent.children = [seq];
  return true;
}
export function findSeqContainerForEdge(
  steps: MissionStep[] | undefined,
  prev: MissionStep,
  next: MissionStep
): { seq: MissionStep; nextIndex: number } | null {
  const search = (arr?: MissionStep[]): { seq: MissionStep; nextIndex: number } | null => {
    if (!arr) return null;
    for (const s of arr) {
      if (isType(s, 'seq')) {
        const cs = s.children ?? [];
        let prevIdx = -1, nextIdx = -1;
        for (let i = 0; i < cs.length; i++) {
          const ch = cs[i];
          if (prevIdx === -1 && containsStep(ch, prev)) prevIdx = i;
          if (nextIdx === -1 && containsStep(ch, next)) nextIdx = i;
          if (prevIdx !== -1 && nextIdx !== -1) break;
        }
        if (prevIdx !== -1 && nextIdx !== -1 && prevIdx + 1 === nextIdx) {
          return { seq: s, nextIndex: nextIdx };
        }
      }
      const deeper = search(s.children);
      if (deeper) return deeper;
    }
    return null;
  };
  return search(steps);
}
export function insertBetween(
  mission: Mission,
  parent: MissionStep | null,
  child: MissionStep,
  mid: MissionStep
): boolean {
  const ensureChildAttached = () => {
    mid.children ??= [];
    if (!mid.children.includes(child)) {
      mid.children.push(child);
    }
  };

  const finalizeInsertion = () => {
    ensureChildAttached();
    detachEverywhere(mission, child, mid);
  };

  if (parent) {
    const parAncestor = findNearestParallelAncestor(mission, parent);
    const parentLoc = findParentAndIndex(mission, parent);

    if (
      parentLoc &&
      parentLoc.parent &&
      isType(parentLoc.parent, 'parallel') &&
      !(parent.children?.length)
    ) {
      const seqWrapper = mk('seq');
      seqWrapper.children = [parent, mid];
      parentLoc.container.splice(parentLoc.index, 1, seqWrapper);
      return true;
    }

    if (parAncestor && !containsStep(parAncestor, child)) {
      const locPrev = findParentAndIndex(mission, parent);
      if (!locPrev) return false;
      const { parent: prevDirectParent, container, index } = locPrev;
      if (prevDirectParent && isType(prevDirectParent, 'seq')) {
        prevDirectParent.children ??= [];
        prevDirectParent.children.splice(index + 1, 0, mid);
      } else {
        const seq = mk('seq');
        seq.children = [parent, mid];
        container.splice(index, 1, seq);
      }
      finalizeInsertion();
      return true;
    }

    const seqHit = findSeqContainerForEdge(mission.steps, parent, child);
    if (seqHit) {
      seqHit.seq.children ??= [];
      seqHit.seq.children.splice(seqHit.nextIndex, 0, mid);
      finalizeInsertion();
      return true;
    }
  }
  if (!parent) {
    mission.steps ??= [];
    const topLevelIndex = mission.steps.indexOf(child);
    if (topLevelIndex !== -1) {
      mission.steps.splice(topLevelIndex, 1, mid);
      finalizeInsertion();
      return true;
    }

    const loc = findParentAndIndex(mission, child);
    if (!loc) return false;
    loc.container.splice(loc.index, 1, mid);
    finalizeInsertion();
    return true;
  }

  if (parent.children?.length === 1 && isType(parent.children[0], 'seq')) {
    const seq = parent.children[0];
    seq.children ??= [];
    const k = seq.children.indexOf(child);
    if (k !== -1) {
      seq.children.splice(k, 0, mid);
      finalizeInsertion();
      return true;
    }
  }

  if (parent.children?.length) {
    const j = parent.children.indexOf(child);
    if (j !== -1) {
      parent.children.splice(j, 1, mid);
      finalizeInsertion();
      return true;
    }
  }
  const par = ensureParallelAfter(mission, parent);
  par.children ??= [];
  const k = par.children.indexOf(child);
  if (k !== -1) {
    par.children.splice(k, 1, mid);
    finalizeInsertion();
    return true;
  }
  const walk = (arr?: MissionStep[]): boolean => {
    if (!arr) return false;
    const idx = arr.indexOf(child);
    if (idx !== -1) {
      arr.splice(idx, 1, mid);
      finalizeInsertion();
      return true;
    }
    return arr.some(s => walk(s.children));
  };
  return walk(mission.steps);
}
