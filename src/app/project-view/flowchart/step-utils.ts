import { MissionStep } from '../../entities/MissionStep';
import { FlowNode, Step, toVal, lc } from './models';

export function asStepFromPool(ms: MissionStep, pool: Step[]): Step {
  const match = pool.find(s => s.name === ms.function_name);
  return match ?? {
    name: ms.function_name,
    import: '',
    arguments: ms.arguments.map((a, i) => ({
      name: a.name || `arg${i}`,
      type: resolveMissionArgumentType(a.type, a.value),
      import: null as any,
      optional: false,
      default: a.value
    })),
    file: ''
  } as Step;
}

export function initialArgsFromPool(ms: MissionStep, pool: Step[]): Record<string, boolean | string | number | null> {
  const match = pool.find(s => s.name === ms.function_name);
  if (match) {
    return Object.fromEntries(match.arguments.map((sa, i) => {
      const storedArg = findStoredArg(ms.arguments ?? [], sa.name, i);
      const hasValue = storedArg !== undefined;
      const source = hasValue ? storedArg!.value : (sa.default ?? '');
      return [sa.name, toVal(sa.type, source)];
    }));
  }
  return Object.fromEntries(ms.arguments.map((a, i) => [
    a.name || `arg${i}`,
    toVal(resolveMissionArgumentType(a.type, a.value), a.value),
  ]));
}

export function missionStepFromAdHoc(n: FlowNode): MissionStep {
  const args = Object.entries(n.args || {}).map(([name, v]) => ({
    name,
    value: v == null ? null : v,
    type: n.step?.arguments?.find(a => a.name === name)?.type ?? 'str'
  }));
  return {
    step_type: lc(n.step?.name) === 'parallel' ? 'parallel' : '',
    function_name: n.step?.name || n.text,
    arguments: args,
    position: {
      x: n.position?.x ?? 0,
      y: n.position?.y ?? 0,
    },
    children: []
  };
}

const normalizeArgName = (name: string | undefined | null): string =>
  (name ?? '').trim().toLowerCase();

const normalizeArgType = (type: string | undefined | null): string =>
  (type ?? '').trim().toLowerCase();

const isBindingArgType = (type: string | undefined | null): boolean => {
  const normalized = normalizeArgType(type);
  return normalized === 'keyword' || normalized === 'kw' || normalized === 'named' || normalized === 'named_argument' ||
    normalized === 'positional' || normalized === 'pos' || normalized === 'position';
};

function resolveMissionArgumentType(type: string | undefined | null, value: unknown): string {
  if (type && !isBindingArgType(type)) {
    return type;
  }
  if (typeof value === 'boolean') {
    return 'bool';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? 'int' : 'float';
  }
  return 'str';
}

const ARG_NAME_ALIASES: string[][] = [
  ['cm', 'distance', 'distance_cm'],
  ['deg', 'degrees', 'angle_deg'],
];

const isGenericArgName = (name: string | undefined | null): boolean => {
  const normalized = normalizeArgName(name);
  return normalized === '' || /^arg\d+$/.test(normalized);
};

const argNamesEquivalent = (left: string | undefined | null, right: string | undefined | null): boolean => {
  const a = normalizeArgName(left);
  const b = normalizeArgName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return ARG_NAME_ALIASES.some(group => group.includes(a) && group.includes(b));
};

const hasConcreteArgValue = (value: unknown): boolean => value !== null && value !== undefined && value !== '';

function findBestStoredArgIndex(
  sourceArgs: MissionStep['arguments'],
  defName: string,
  fallbackIndex: number,
  usedIndices?: Set<number>
): number {
  let bestIndex = -1;
  let bestScore = -1;
  const normalizedDefName = normalizeArgName(defName);

  sourceArgs.forEach((arg, index) => {
    if (usedIndices?.has(index)) {
      return;
    }

    const normalizedArgName = normalizeArgName(arg.name);
    let score = -1;

    if (argNamesEquivalent(arg.name, defName)) {
      const isExactMatch = normalizedArgName === normalizedDefName;
      score = isExactMatch ? 2 : 1;
      if (hasConcreteArgValue(arg.value)) {
        score += 3;
      }
    } else if (
      fallbackIndex >= 0 &&
      index === fallbackIndex &&
      isGenericArgName(arg.name)
    ) {
      score = hasConcreteArgValue(arg.value) ? 1 : 0;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function findStoredArg(
  sourceArgs: MissionStep['arguments'],
  defName: string,
  fallbackIndex: number,
  usedIndices?: Set<number>
): MissionStep['arguments'][number] | undefined {
  const sourceIndex = findBestStoredArgIndex(sourceArgs, defName, fallbackIndex, usedIndices);
  return sourceIndex !== -1 ? sourceArgs[sourceIndex] : undefined;
}

function toMissionArgValue(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

export function canonicalizeMissionStepArguments(ms: MissionStep, pool: Step[]): MissionStep {
  const match = pool.find(s => s.name === ms.function_name);
  const normalizedChildren = (ms.children ?? []).map(child => canonicalizeMissionStepArguments(child, pool));

  if (!match) {
    return { ...ms, children: normalizedChildren };
  }

  const sourceArgs = ms.arguments ?? [];
  const usedIndices = new Set<number>();
  const canonicalArgs = match.arguments.flatMap((def, index) => {
    const sourceIndex = findBestStoredArgIndex(sourceArgs, def.name, index, usedIndices);
    if (sourceIndex !== -1) {
      usedIndices.add(sourceIndex);
    }
    const source = sourceIndex !== -1 ? sourceArgs[sourceIndex] : undefined;
    return [{
      name: def.name,
      value: toMissionArgValue(source?.value ?? def.default ?? null),
      type: def.type || source?.type || 'str',
    }];
  });

  const remainingArgs = sourceArgs.filter((arg, index) =>
    !usedIndices.has(index) &&
    !match.arguments.some(def => argNamesEquivalent(arg.name, def.name))
  );

  return {
    ...ms,
    arguments: [...canonicalArgs, ...remainingArgs],
    children: normalizedChildren,
  };
}
