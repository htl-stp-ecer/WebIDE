import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { isType, mk } from './models';

// Keep helper-style, pure utilities for manipulating Mission/MissionStep trees.

export function ensureTopLevelParallel(mission: Mission): MissionStep {
  mission.steps ??= [];
  const first = mission.steps[0];
  if (first && isType(first, 'parallel')) return first;
  const par = mk('parallel');
  if (first) {
    mission.steps.splice(0, 1, par);
    par.children = [...(par.children ?? []), first];
  } else mission.steps.push(par);
  return par;
}

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
  mission.steps = (mission.steps ?? []).filter(s => s !== target);
  const walk = (p: MissionStep): void => {
    const cs = p.children ?? [];
    if (!cs.length) return;
    p.children = cs.filter(ch => (exceptParent && p === exceptParent) || ch !== target);
    (p.children ?? []).forEach(walk);
  };
  (mission.steps ?? []).forEach(walk);
}

export function ensureParallelAfter(mission: Mission, parent: MissionStep | null): MissionStep {
  // If parent is null, ensure a top-level parallel and return it.
  if (!parent) return ensureTopLevelParallel(mission);

  // Locate the direct container that holds `parent`
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
        // Create a new PARALLEL right after the PARALLEL group and return it.
        const afterPar = mk('parallel');
        outerContainer.splice(outerIndex + 1, 0, afterPar);
        return afterPar;
      }
    }
    // Not the last group — add as another lane in the same parallel
    return directParent;
  }

  // Otherwise behave like before: ensure a PARALLEL right *after* `parent`
  const next = container[index + 1];
  if (next && isType(next, 'parallel')) return next;

  const par = mk('parallel');
  container.splice(index + 1, 0, par);

  // If there was a "next" step, move it into the new parallel as a lane
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

export function containsStep(root: MissionStep, target: MissionStep): boolean {
  if (root === target) return true;
  return (root.children ?? []).some(ch => containsStep(ch, target));
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

export function normalize(mission: Mission, t: 'parallel' | 'seq'): void {
  const walk = (arr?: MissionStep[]) => {
    if (!arr) return;
    for (let i = 0; i < arr.length;) {
      const s = arr[i];
      walk(s.children);
      if (isType(s, t)) {
        const ch = s.children ?? [];
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

export function attachChildWithParallel(mission: Mission, parent: MissionStep, child: MissionStep): boolean {
  if (parent === child) return false;

  const par = ensureParallelAfter(mission, parent); // creates or reuses a parallel right after parent
  par.children ??= [];

  // If child is itself a parallel, merge its children into the parallel-after-parent
  if (isType(child, 'parallel')) {
    par.children.push(...(child.children ?? []));
    detachEverywhere(mission, child);
  } else {
    // detach child from wherever it currently lives and add it as another lane
    detachEverywhere(mission, child);
    if (!par.children.includes(child)) par.children.push(child);
  }

  return true;
}

export function findNearestParallelAncestor(mission: Mission, step: MissionStep): MissionStep | null {
  let found: MissionStep | null = null;
  const dfs = (arr: MissionStep[] | undefined, stack: MissionStep[] = []): boolean => {
    if (!arr) return false;
    for (const s of arr) {
      const stack2 = [...stack, s];
      if (s === step) {
        for (let i = stack2.length - 1; i >= 0; i--) {
          if (isType(stack2[i], 'parallel')) {
            found = stack2[i];
            break;
          }
        }
        return true;
      }
      if (dfs(s.children, stack2)) return true;
    }
    return false;
  };
  dfs(mission.steps);
  return found;
}

export function insertBetween(
  mission: Mission,
  parent: MissionStep | null,
  child: MissionStep,
  mid: MissionStep
): boolean {
  // 0) LANE → OUTSIDE: if `parent` is inside a PARALLEL and `child` is outside it,
  //    insert `mid` INTO THE LANE (wrap with SEQ or insert into existing lane SEQ).
  if (parent) {
    const parAncestor = findNearestParallelAncestor(mission, parent);
    if (parAncestor && !containsStep(parAncestor, child)) {
      const locPrev = findParentAndIndex(mission, parent);
      if (!locPrev) return false;

      const { parent: prevDirectParent, container, index } = locPrev;

      // If lane already has a SEQ, insert after `parent`
      if (prevDirectParent && isType(prevDirectParent, 'seq')) {
        prevDirectParent.children ??= [];
        prevDirectParent.children.splice(index + 1, 0, mid);
      } else {
        // Wrap the lane element with SEQ(parent, mid)
        const seq = mk('seq');
        seq.children = [parent, mid];
        container.splice(index, 1, seq);
      }
      return true;
    }
  }

  // 1) If prev & next are adjacent siblings inside a SEQ wrapper, insert into that SEQ
  if (parent) {
    const seqHit = findSeqContainerForEdge(mission.steps, parent, child);
    if (seqHit) {
      seqHit.seq.children ??= [];
      seqHit.seq.children.splice(seqHit.nextIndex, 0, mid);
      return true;
    }
  }

  // 2) Top-level
  if (!parent) {
    const i = (mission.steps ?? []).indexOf(child);
    if (i === -1) return false;
    mission.steps.splice(i, 1, mid);
    mid.children = [child];
    return true;
  }

  // 3) Parent has single SEQ child and edge is inside that SEQ (legacy fast-path)
  if (parent.children?.length === 1 && isType(parent.children[0], 'seq')) {
    const seq = parent.children[0];
    seq.children ??= [];
    const k = seq.children.indexOf(child);
    if (k !== -1) {
      seq.children.splice(k, 0, mid);
      return true;
    }
  }

  // 4) Direct child of parent
  if (parent.children?.length) {
    const j = parent.children.indexOf(child);
    if (j !== -1) {
      parent.children.splice(j, 1, mid);
      mid.children = [child];
      return true;
    }
  }

  // 5) Fallbacks (now lane-aware via ensureParallelAfter)
  const par = ensureParallelAfter(mission, parent);
  par.children ??= [];
  const k = par.children.indexOf(child);
  if (k !== -1) {
    par.children.splice(k, 1, mid);
    mid.children = [child];
    return true;
  }

  const walk = (arr?: MissionStep[]): boolean => {
    if (!arr) return false;
    const i = arr.indexOf(child);
    if (i !== -1) {
      arr.splice(i, 1, mid);
      return true;
    }
    return arr.some((s) => walk(s.children));
  };
  if (walk(mission.steps)) {
    mid.children = [child];
    return true;
  }

  return false;
}
