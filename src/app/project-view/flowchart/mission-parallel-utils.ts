import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { isType, mk } from './models';
import { detachEverywhere, findParentAndIndex } from './mission-tree-utils';

export function ensureTopLevelParallel(mission: Mission): MissionStep {
  mission.steps ??= [];
  const first = mission.steps[0];
  if (first && isType(first, 'parallel')) return first;
  const par = mk('parallel');
  if (first) {
    mission.steps.splice(0, 1, par);
    par.children = [...(par.children ?? []), first];
  } else {
    mission.steps.push(par);
  }
  return par;
}

export function ensureParallelAfter(mission: Mission, parent: MissionStep | null): MissionStep {
  if (!parent) return ensureTopLevelParallel(mission);

  if (isType(parent, 'seq')) {
    parent.children ??= [];
    const firstChild = parent.children[0];
    if (!firstChild) {
      const par = mk('parallel');
      parent.children.unshift(par);
      return par;
    }
    if (isType(firstChild, 'parallel')) return firstChild;
    const par = mk('parallel');
    parent.children.splice(0, 1, par);
    par.children = [firstChild];
    return par;
  }

  const loc = findParentAndIndex(mission, parent);
  if (!loc) return mk('parallel');
  const { parent: directParent, container, index } = loc;

  if (
    directParent &&
    isType(directParent, 'seq') &&
    directParent.children === container &&
    index === 0
  ) {
    if (isType(parent, 'parallel')) return parent;
    const par = mk('parallel');
    container.splice(index, 1, par);
    par.children = [parent];
    return par;
  }

  if (directParent && isType(directParent, 'parallel') && directParent.children === container) {
    const laneCount = (directParent.children ?? []).length;
    const outer = findParentAndIndex(mission, directParent);
    if (outer) {
      const { container: outerContainer, index: outerIndex } = outer;
      const outerNext = outerContainer[outerIndex + 1];
      if (!outerNext && laneCount >= 2) {
        const afterPar = mk('parallel');
        outerContainer.splice(outerIndex + 1, 0, afterPar);
        return afterPar;
      }
    }
    return directParent;
  }

  const next = container[index + 1];
  if (next && isType(next, 'parallel')) return next;
  if (next && isType(next, 'seq')) {
    next.children ??= [];
    const firstSeqChild = next.children[0];
    if (firstSeqChild && isType(firstSeqChild, 'parallel')) return firstSeqChild;
    const parInsideSeq = mk('parallel');
    if (firstSeqChild) {
      next.children.splice(0, 1, parInsideSeq);
      parInsideSeq.children = [firstSeqChild];
    } else {
      next.children.unshift(parInsideSeq);
    }
    return parInsideSeq;
  }

  const par = mk('parallel');
  container.splice(index + 1, 0, par);
  if (next) {
    container.splice(index + 2, 1);
    par.children = [...(par.children ?? []), next];
  }
  return par;
}

export function attachToStartWithParallel(mission: Mission, child: MissionStep): boolean {
  const par = ensureTopLevelParallel(mission);
  par.children ??= [];
  detachEverywhere(mission, child);
  if (!par.children.includes(child)) par.children.push(child);
  return true;
}

export function attachChildWithParallel(mission: Mission, parent: MissionStep, child: MissionStep): boolean {
  if (parent === child) return false;

  const children = parent.children ?? [];
  if (
    children.length === 1 &&
    !isType(children[0], 'seq') &&
    !isType(children[0], 'parallel')
  ) {
    const existing = children[0];
    const tail = existing.children ? [...existing.children] : [];
    existing.children = [];

    const par = mk('parallel');
    par.children = [existing];

    detachEverywhere(mission, child);
    par.children.push(child);

    if (tail.length) {
      const seq = mk('seq');
      seq.children = [par, ...tail];
      parent.children = [seq];
    } else {
      parent.children = [par];
    }

    return true;
  }

  const par = ensureParallelAfter(mission, parent);
  par.children ??= [];

  if (isType(child, 'parallel')) {
    par.children.push(...(child.children ?? []));
    detachEverywhere(mission, child);
  } else {
    detachEverywhere(mission, child);
    if (!par.children.includes(child)) par.children.push(child);
  }

  return true;
}
