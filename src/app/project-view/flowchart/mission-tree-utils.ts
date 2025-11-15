import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { isType } from './models';

export function findParentAndIndex(
  mission: Mission,
  target: MissionStep
): { parent: MissionStep | null; container: MissionStep[]; index: number } | null {
  const dfs = (arr: MissionStep[] | undefined, parent: MissionStep | null): any => {
    if (!arr) return null;
    const idx = arr.indexOf(target);
    if (idx !== -1) return { parent, container: arr, index: idx };
    for (const s of arr) {
      const r = dfs(s.children, s);
      if (r) return r;
    }
    return null;
  };
  return dfs(mission.steps, null);
}

export function detachEverywhere(mission: Mission, target: MissionStep, exceptParent?: MissionStep): void {
  const steps = mission.steps ?? [];
  const filteredTopLevel = steps.filter(s => s !== target);
  if (filteredTopLevel.length !== steps.length) {
    mission.steps = filteredTopLevel;
  } else {
    mission.steps = steps;
  }
  const walk = (p: MissionStep): void => {
    const cs = p.children ?? [];
    if (!cs.length) return;
    p.children = cs.filter(ch => (exceptParent && p === exceptParent) || ch !== target);
    (p.children ?? []).forEach(walk);
  };
  (mission.steps ?? []).forEach(walk);
}

export function containsStep(root: MissionStep, target: MissionStep): boolean {
  if (root === target) return true;
  return (root.children ?? []).some(ch => containsStep(ch, target));
}

export function normalize(mission: Mission, t: 'parallel' | 'seq'): void {
  const walk = (arr?: MissionStep[]) => {
    if (!arr) return;
    for (let i = 0; i < arr.length;) {
      const step = arr[i];
      walk(step.children);
      if (isType(step, t)) {
        const ch = step.children ?? [];
        if (ch.length <= 1) {
          arr.splice(i, 1, ...ch);
          continue;
        }
      }
      i++;
    }
  };
  mission.steps ??= [];
  walk(mission.steps);
}

export function findNearestParallelAncestor(mission: Mission, step: MissionStep): MissionStep | null {
  let found: MissionStep | null = null;
  const dfs = (arr: MissionStep[] | undefined, stack: MissionStep[] = []): boolean => {
    if (!arr) return false;
    for (const s of arr) {
      const nextStack = [...stack, s];
      if (s === step) {
        for (let i = nextStack.length - 1; i >= 0; i--) {
          if (isType(nextStack[i], 'parallel')) {
            found = nextStack[i];
            break;
          }
        }
        return true;
      }
      if (dfs(s.children, nextStack)) return true;
    }
    return false;
  };
  dfs(mission.steps);
  return found;
}
