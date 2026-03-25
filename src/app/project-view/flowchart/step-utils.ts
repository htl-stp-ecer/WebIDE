import { MissionStep } from '../../entities/MissionStep';
import { FlowNode, Step, toVal, lc } from './models';

const UNTIL_BUILDER_SUFFIX = '.until';
const RAW_EXPRESSION_MARKERS = ['(', ')', '.', '_'];

type MissionArgument = MissionStep['arguments'][number];

type BuilderArgToken = {
  binding: 'keyword' | 'positional';
  name: string | null;
  value: string | number | boolean | null;
};

type BuilderChain = {
  baseName: string;
  methodName: string;
  baseArgs: BuilderArgToken[];
};

export function asStepFromPool(ms: MissionStep, pool: Step[]): Step {
  const builderStep = buildBuilderStepView(ms, pool);
  if (builderStep) {
    return builderStep.step;
  }

  const match = pool.find(s => s.name === ms.function_name);
  const fallbackName = resolveFallbackStepName(ms);
  return match ?? {
    name: fallbackName,
    import: '',
    arguments: ms.arguments.map((a, i) => ({
      name: resolveFallbackArgName(ms, a.name, i),
      type: resolveMissionArgumentType(a.type, a.value),
      import: null as any,
      optional: false,
      default: a.value
    })),
    file: ''
  } as Step;
}

export function initialArgsFromPool(ms: MissionStep, pool: Step[]): Record<string, boolean | string | number | null> {
  const builderStep = buildBuilderStepView(ms, pool);
  if (builderStep) {
    return builderStep.args;
  }

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
    resolveFallbackArgName(ms, a.name, i),
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

export function isBuilderDerivedStep(step: Step | null | undefined): boolean {
  return !!step?.builderBaseName && !!step?.builderMethodName;
}

export function applyBuilderStepArgsToMissionStep(
  missionStep: MissionStep,
  step: Step,
  args: Record<string, boolean | string | number | null>
): boolean {
  if (!isBuilderDerivedStep(step)) {
    return false;
  }

  const baseArgs = step.arguments
    .filter(arg => arg.builderSource === 'base')
    .flatMap(arg => {
      const value = toMissionArgValue(args[arg.name]);
      if (value == null || value === '') {
        return [];
      }
      const binding = arg.builderBinding ?? 'keyword';
      const rawName = binding === 'keyword' ? (arg.builderRawName ?? arg.name) : null;
      return [formatBuilderArgument(binding, rawName, value)];
    });

  const methodArgs = step.arguments
    .filter(arg => arg.builderSource === 'method')
    .flatMap(arg => {
      const value = toMissionArgValue(args[arg.name]);
      if (value == null || value === '') {
        return [];
      }
      const binding = arg.builderBinding ?? 'positional';
      return [{
        name: binding === 'keyword' ? (arg.builderRawName ?? arg.name) : '',
        value,
        type: binding,
      }];
    });

  missionStep.function_name = `${step.builderBaseName}(${baseArgs.join(', ')}).${step.builderMethodName}`;
  missionStep.step_type = missionStep.function_name;
  missionStep.arguments = methodArgs;
  return true;
}

function buildBuilderStepView(
  ms: MissionStep,
  pool: Step[]
): { step: Step; args: Record<string, boolean | string | number | null> } | null {
  const chain = parseBuilderChain(ms.function_name ?? '');
  if (!chain) {
    return null;
  }

  const baseMatch = pool.find(step => step.name === chain.baseName);
  const baseArgs = buildBaseBuilderArgDefs(chain, baseMatch);
  const methodArgs = buildMethodBuilderArgDefs(chain.methodName, ms.arguments ?? []);
  const args = Object.fromEntries(
    [...baseArgs, ...methodArgs].map(arg => [arg.name, toVal(arg.type, arg.default ?? null)])
  );

  return {
    step: {
      name: resolveBuilderDisplayName(chain, ms.arguments ?? []),
      import: baseMatch?.import ?? '',
      file: baseMatch?.file ?? '',
      tags: baseMatch?.tags,
      builderBaseName: chain.baseName,
      builderMethodName: chain.methodName,
      arguments: [...baseArgs, ...methodArgs],
    },
    args,
  };
}

function resolveFallbackStepName(ms: MissionStep): string {
  const rawName = (ms.function_name ?? '').trim();
  if (!isUntilBuilderStep(rawName)) {
    return rawName;
  }

  const baseName = extractBuilderBaseName(rawName);
  if (!baseName) {
    return rawName;
  }

  const color = extractUntilConditionColor(ms.arguments ?? []);
  return color ? `${baseName}_until_${color}` : `${baseName}_until`;
}

function resolveFallbackArgName(ms: MissionStep, explicitName: string | undefined | null, index: number): string {
  if (explicitName && explicitName.trim()) {
    return explicitName;
  }

  if (isUntilBuilderStep(ms.function_name ?? '')) {
    return index === 0 ? 'condition' : `condition${index}`;
  }

  return `arg${index}`;
}

function isUntilBuilderStep(functionName: string): boolean {
  return functionName.includes(UNTIL_BUILDER_SUFFIX);
}

function extractBuilderBaseName(functionName: string): string | null {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/s.exec(functionName);
  return match?.[1] ?? null;
}

function extractUntilConditionColor(argumentsList: MissionStep['arguments']): 'black' | 'white' | null {
  for (const arg of argumentsList) {
    if (typeof arg?.value !== 'string') {
      continue;
    }
    const match = /\bon_(black|white)\s*\(/i.exec(arg.value);
    if (match?.[1]) {
      return match[1].toLowerCase() as 'black' | 'white';
    }
  }
  return null;
}

function parseBuilderChain(functionName: string): BuilderChain | null {
  const trimmed = functionName.trim();
  if (!trimmed.includes('.')) {
    return null;
  }

  const match = /^([\s\S]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const baseExpression = match[1]?.trim();
  const methodName = match[2]?.trim();
  if (!baseExpression || !methodName) {
    return null;
  }

  const openIndex = baseExpression.indexOf('(');
  if (openIndex === -1 || !baseExpression.endsWith(')')) {
    return null;
  }

  const baseName = baseExpression.slice(0, openIndex).trim();
  const rawArgs = baseExpression.slice(openIndex + 1, -1);
  if (!baseName) {
    return null;
  }

  return {
    baseName,
    methodName,
    baseArgs: parseBuilderArgumentList(rawArgs),
  };
}

function parseBuilderArgumentList(rawArgs: string): BuilderArgToken[] {
  const segments = splitTopLevel(rawArgs, ',');
  return segments
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
    .map(segment => {
      const equalsIndex = indexOfTopLevel(segment, '=');
      if (equalsIndex === -1) {
        return {
          binding: 'positional',
          name: null,
          value: parseBuilderValueExpression(segment),
        } as BuilderArgToken;
      }

      const name = segment.slice(0, equalsIndex).trim();
      const value = segment.slice(equalsIndex + 1).trim();
      return {
        binding: 'keyword',
        name: name || null,
        value: parseBuilderValueExpression(value),
      } as BuilderArgToken;
    });
}

function buildBaseBuilderArgDefs(chain: BuilderChain, baseMatch: Step | undefined): Step['arguments'] {
  if (!baseMatch) {
    return chain.baseArgs.map((arg, index) => ({
      name: arg.name || `arg${index}`,
      type: resolveMissionArgumentType(undefined, arg.value),
      default: arg.value,
      builderSource: 'base' as const,
      builderBinding: arg.binding,
      builderRawName: arg.name,
    }));
  }

  const used = new Set<number>();
  const defs = baseMatch.arguments.map((def, index) => {
    const sourceIndex = findBestBuilderTokenIndex(chain.baseArgs, def.name, index, used);
    if (sourceIndex !== -1) {
      used.add(sourceIndex);
    }
    const source = sourceIndex !== -1 ? chain.baseArgs[sourceIndex] : undefined;
    const value = source?.value ?? def.default ?? null;
    return {
      name: def.name,
      type: resolveBuilderArgumentType(value, def.type),
      default: value,
      builderSource: 'base' as const,
      builderBinding: source?.binding ?? 'keyword',
      builderRawName: source?.binding === 'keyword' ? (source.name ?? def.name) : null,
    };
  });

  const remaining = chain.baseArgs
    .map((arg, index) => ({ arg, index }))
    .filter(entry => !used.has(entry.index))
    .map((entry, index) => ({
      name: entry.arg.name || `arg${baseMatch.arguments.length + index}`,
      type: resolveMissionArgumentType(undefined, entry.arg.value),
      default: entry.arg.value,
      builderSource: 'base' as const,
      builderBinding: entry.arg.binding,
      builderRawName: entry.arg.name,
    }));

  return [...defs, ...remaining];
}

function buildMethodBuilderArgDefs(methodName: string, argumentsList: MissionStep['arguments']): Step['arguments'] {
  return argumentsList.map((arg, index) => {
    const binding = normalizeBuilderBinding(arg.type, arg.name);
    const displayName = resolveMethodArgDisplayName(methodName, arg, index, argumentsList.length);
    const value = arg.value ?? null;
    return {
      name: displayName,
      type: resolveBuilderArgumentType(value, arg.type),
      default: value,
      builderSource: 'method' as const,
      builderBinding: binding,
      builderRawName: arg.name ?? null,
    };
  });
}

function resolveBuilderDisplayName(chain: BuilderChain, methodArgs: MissionStep['arguments']): string {
  if (chain.methodName === 'until') {
    const color = extractUntilConditionColor(methodArgs);
    return color ? `${chain.baseName}_until_${color}` : `${chain.baseName}.until`;
  }
  return `${chain.baseName}.${chain.methodName}`;
}

function resolveMethodArgDisplayName(
  methodName: string,
  arg: MissionArgument,
  index: number,
  total: number
): string {
  if (arg.name?.trim()) {
    return arg.name;
  }
  if (methodName === 'until') {
    return index === 0 ? 'condition' : `condition${index}`;
  }
  if (total === 1) {
    return methodName;
  }
  return `${methodName}${index}`;
}

function normalizeBuilderBinding(type: string | undefined | null, name: string | undefined | null): 'keyword' | 'positional' {
  return isBindingArgType(type) ? ((normalizeArgType(type) === 'keyword' || normalizeArgType(type) === 'kw' || normalizeArgType(type) === 'named' || normalizeArgType(type) === 'named_argument') ? 'keyword' : 'positional') : (name ? 'keyword' : 'positional');
}

function resolveBuilderArgumentType(value: unknown, fallbackType?: string | null): string {
  if (value !== null && value !== undefined && value !== '') {
    return resolveMissionArgumentType(undefined, value);
  }
  return resolveMissionArgumentType(fallbackType, value);
}

function parseBuilderValueExpression(raw: string): string | number | boolean | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'True') {
    return true;
  }
  if (trimmed === 'False') {
    return false;
  }
  if (trimmed === 'None') {
    return null;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return Number.isInteger(numeric) ? Math.trunc(numeric) : numeric;
  }
  return trimmed;
}

function splitTopLevel(input: string, separator: string): string[] {
  if (!input.trim()) {
    return [];
  }

  const parts: string[] = [];
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let quote: '\'' | '"' | null = null;
  let escape = false;
  let current = '';

  for (const char of input) {
    if (quote) {
      current += char;
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '\'' || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(') depthParen += 1;
    else if (char === ')') depthParen = Math.max(0, depthParen - 1);
    else if (char === '[') depthBracket += 1;
    else if (char === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (char === '{') depthBrace += 1;
    else if (char === '}') depthBrace = Math.max(0, depthBrace - 1);

    if (char === separator && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  parts.push(current);
  return parts;
}

function indexOfTopLevel(input: string, target: string): number {
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let quote: '\'' | '"' | null = null;
  let escape = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '\'' || char === '"') {
      quote = char;
      continue;
    }

    if (char === '(') depthParen += 1;
    else if (char === ')') depthParen = Math.max(0, depthParen - 1);
    else if (char === '[') depthBracket += 1;
    else if (char === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (char === '{') depthBrace += 1;
    else if (char === '}') depthBrace = Math.max(0, depthBrace - 1);

    if (char === target && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      return index;
    }
  }

  return -1;
}

function findBestBuilderTokenIndex(
  tokens: BuilderArgToken[],
  defName: string,
  fallbackIndex: number,
  usedIndices: Set<number>
): number {
  let bestIndex = -1;
  let bestScore = -1;
  const normalizedDefName = normalizeArgName(defName);

  tokens.forEach((token, index) => {
    if (usedIndices.has(index)) {
      return;
    }

    let score = -1;
    if (token.binding === 'keyword' && argNamesEquivalent(token.name, defName)) {
      score = normalizeArgName(token.name) === normalizedDefName ? 5 : 4;
    } else if (token.binding === 'positional' && index === fallbackIndex) {
      score = 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function formatBuilderArgument(binding: 'keyword' | 'positional', name: string | null, value: string | number | boolean): string {
  const renderedValue = formatBuilderValue(value);
  if (binding === 'keyword' && name) {
    return `${name}=${renderedValue}`;
  }
  return renderedValue;
}

function formatBuilderValue(value: string | number | boolean): string {
  if (typeof value === 'string') {
    if (value.startsWith('lambda') || RAW_EXPRESSION_MARKERS.some(marker => value.includes(marker))) {
      return value;
    }
    return `"${value}"`;
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  return String(value);
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
  ['speed', 'velocity', 'power', 'forward_speed'],
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
