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

  const loc = findParentAndIndex(mission, parent);
  if (!loc) return mk('parallel');
  const { parent: directParent, container, index } = loc;

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
