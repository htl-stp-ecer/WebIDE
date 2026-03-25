import { MissionStep } from '../../entities/MissionStep';
import {
  FlowNode,
  Step,
  StepArgDef,
  StepChainMethod,
  StepChainSelection,
  chainMethodChildren,
  lc,
  stepChainMethods,
  toVal,
} from './models';

const RAW_EXPRESSION_MARKERS = ['(', ')', '.', '_'];

type MissionArgument = MissionStep['arguments'][number];

type BuilderArgToken = {
  binding: 'keyword' | 'positional';
  name: string | null;
  value: string | number | boolean | null;
};

type BuilderChainLink = {
  methodName: string;
  args: BuilderArgToken[];
};

type BuilderChain = {
  baseName: string;
  baseArgs: BuilderArgToken[];
  links: BuilderChainLink[];
};

type SerializedBuilderStep = {
  functionName: string;
  stepType: string;
  arguments: MissionStep['arguments'];
  text: string;
};

export function prepareStepForFlowEditor(step: Step): Step {
  if (!isBuilderDerivedStep(step)) {
    return step;
  }

  const baseArgs = extractBaseBuilderArgDefs(step);
  const selections = effectiveChainSelections(step);

  return {
    ...step,
    builderBaseName: step.builderBaseName ?? step.name,
    builderMethodName: selections.at(-1)?.methodName,
    chainMethods: cloneChainMethods(stepChainMethods(step)),
    chainSelections: selections,
    arguments: flattenBuilderArguments(baseArgs, selections),
  };
}

export function asStepFromPool(ms: MissionStep, pool: Step[]): Step {
  const builderStep = buildBuilderStepView(ms, pool);
  if (builderStep) {
    return builderStep.step;
  }

  const match = pool.find(step => step.name === ms.function_name);
  if (match) {
    return prepareStepForFlowEditor(match);
  }

  const fallbackName = resolveFallbackStepName(ms);
  return {
    name: fallbackName,
    import: '',
    arguments: ms.arguments.map((a, i) => ({
      name: resolveFallbackArgName(ms, a.name, i),
      label: resolveFallbackArgName(ms, a.name, i),
      type: resolveMissionArgumentType(a.type, a.value),
      import: null as any,
      optional: false,
      default: a.value,
    })),
    file: '',
  } as Step;
}

export function initialArgsFromPool(ms: MissionStep, pool: Step[]): Record<string, boolean | string | number | null> {
  const builderStep = buildBuilderStepView(ms, pool);
  if (builderStep) {
    return builderStep.args;
  }

  const match = pool.find(step => step.name === ms.function_name);
  if (match) {
    return Object.fromEntries(match.arguments.map((sa, index) => {
      const storedArg = findStoredArg(ms.arguments ?? [], sa.name, index);
      const value = storedArg?.value ?? sa.default ?? null;
      return [sa.name, toVal(sa.type, value)];
    }));
  }

  return Object.fromEntries(ms.arguments.map((a, index) => [
    resolveFallbackArgName(ms, a.name, index),
    toVal(resolveMissionArgumentType(a.type, a.value), a.value),
  ]));
}

export function missionStepFromAdHoc(node: FlowNode): MissionStep {
  if (isBuilderDerivedStep(node.step)) {
    const serialized = serializeBuilderStep(node.step, node.args ?? {}, node.text);
    return {
      step_type: serialized.stepType,
      function_name: serialized.functionName,
      arguments: serialized.arguments,
      position: {
        x: node.position?.x ?? 0,
        y: node.position?.y ?? 0,
      },
      children: [],
    };
  }

  const args = Object.entries(node.args || {}).map(([name, value]) => ({
    name,
    value: value == null ? null : value,
    type: node.step?.arguments?.find(arg => arg.name === name)?.type ?? 'str',
  }));

  return {
    step_type: lc(node.step?.name) === 'parallel' ? 'parallel' : '',
    function_name: node.step?.name || node.text,
    arguments: args,
    position: {
      x: node.position?.x ?? 0,
      y: node.position?.y ?? 0,
    },
    children: [],
  };
}

export function isBuilderDerivedStep(step: Step | null | undefined): boolean {
  return !!step && (
    !!step.builderBaseName ||
    stepChainMethods(step).length > 0 ||
    !!step.chainSelections?.length
  );
}

export function builderBaseArguments(step: Step | null | undefined): StepArgDef[] {
  if (!step) {
    return [];
  }
  return extractBaseBuilderArgDefs(step);
}

export function builderChainSelections(step: Step | null | undefined): StepChainSelection[] {
  return effectiveChainSelections(step);
}

export function builderChainArguments(step: Step | null | undefined, chainIndex: number): StepArgDef[] {
  return cloneArgDefs(effectiveChainSelections(step)[chainIndex]?.arguments ?? []);
}

export function availableBuilderChainMethods(step: Step | null | undefined, level: number): StepChainMethod[] {
  if (!step) {
    return [];
  }

  const rootMethods = stepChainMethods(step);
  if (!rootMethods.length) {
    return [];
  }
  if (level <= 0) {
    return cloneChainMethods(rootMethods);
  }

  let methods = rootMethods;
  const selections = effectiveChainSelections(step);

  for (let index = 0; index < level; index += 1) {
    const selection = selections[index];
    if (!selection) {
      return [];
    }

    const matched = methods.find(method => method.name === selection.methodName);
    if (!matched) {
      return [];
    }

    const children = chainMethodChildren(matched);
    methods = children.length ? children : rootMethods;
  }

  return cloneChainMethods(methods);
}

export function setBuilderChainMethodSelection(
  step: Step,
  currentArgs: Record<string, boolean | string | number | null>,
  level: number,
  methodName: string | null | undefined
): Record<string, boolean | string | number | null> {
  const normalizedMethodName = (methodName ?? '').trim();
  const baseArgs = extractBaseBuilderArgDefs(step);
  const existingSelections = effectiveChainSelections(step);
  const nextSelections = existingSelections.slice(0, level);

  if (normalizedMethodName) {
    const available = availableBuilderChainMethods(step, level);
    const matched = available.find(method => method.name === normalizedMethodName);
    const previousSelection = existingSelections[level];

    nextSelections[level] = matched
      ? {
        methodName: matched.name,
        arguments: buildMethodArgDefsFromCatalog(
          matched,
          level,
          baseArgs,
          nextSelections,
          previousSelection?.methodName === matched.name ? previousSelection.arguments : undefined
        ),
      }
      : {
        methodName: normalizedMethodName,
        arguments: buildFallbackMethodArgDefs(normalizedMethodName, [], level, baseArgs, nextSelections),
      };
  }

  step.builderBaseName ??= step.name;
  step.chainSelections = nextSelections;
  step.builderMethodName = nextSelections.at(-1)?.methodName;
  step.arguments = flattenBuilderArguments(baseArgs, nextSelections);
  step.name = resolveBuilderDisplayName(step, currentArgs);

  return rebuildBuilderArgState(step, currentArgs);
}

export function rebuildBuilderArgState(
  step: Step,
  currentArgs: Record<string, boolean | string | number | null>
): Record<string, boolean | string | number | null> {
  const nextArgs: Record<string, boolean | string | number | null> = {};
  for (const arg of step.arguments ?? []) {
    if (Object.prototype.hasOwnProperty.call(currentArgs, arg.name)) {
      nextArgs[arg.name] = currentArgs[arg.name] ?? null;
      continue;
    }
    nextArgs[arg.name] = toVal(arg.type, arg.default ?? null);
  }
  return nextArgs;
}

export function resolveBuilderDisplayName(
  step: Step | null | undefined,
  args: Record<string, boolean | string | number | null>
): string {
  if (!step) {
    return '';
  }

  const baseName = step.builderBaseName ?? step.name;
  const selections = effectiveChainSelections(step);
  if (!selections.length) {
    return baseName;
  }

  if (selections.length === 1 && selections[0]?.methodName === 'until') {
    const color = extractUntilConditionColorFromSelection(selections[0], args);
    return color ? `${baseName}_until_${color}` : `${baseName}.until`;
  }

  return `${baseName}.${selections.map(selection => selection.methodName).join('.')}`;
}

export function applyBuilderStepArgsToMissionStep(
  missionStep: MissionStep,
  step: Step,
  args: Record<string, boolean | string | number | null>
): boolean {
  if (!isBuilderDerivedStep(step)) {
    return false;
  }

  const serialized = serializeBuilderStep(step, args, resolveBuilderDisplayName(step, args));
  missionStep.function_name = serialized.functionName;
  missionStep.step_type = serialized.stepType;
  missionStep.arguments = serialized.arguments;
  return true;
}

function buildBuilderStepView(
  ms: MissionStep,
  pool: Step[]
): { step: Step; args: Record<string, boolean | string | number | null> } | null {
  const chain = parseBuilderChain(ms.function_name ?? '', ms.arguments ?? []);
  if (!chain) {
    return null;
  }

  const baseMatch = pool.find(step => step.name === chain.baseName);
  const baseArgs = buildBaseBuilderArgDefs(chain, baseMatch);
  const chainMethods = buildChainMethodCatalog(baseMatch, chain.links);
  const selections = buildChainSelections(chain, chainMethods, baseArgs);
  const step = {
    name: '',
    import: baseMatch?.import ?? '',
    file: baseMatch?.file ?? '',
    tags: baseMatch?.tags,
    builderBaseName: chain.baseName,
    builderMethodName: selections.at(-1)?.methodName,
    chainMethods,
    chainSelections: selections,
    arguments: flattenBuilderArguments(baseArgs, selections),
  } as Step;
  const args = Object.fromEntries(
    step.arguments.map(arg => [arg.name, toVal(arg.type, arg.default ?? null)])
  );
  step.name = resolveBuilderDisplayName(step, args);

  return { step, args };
}

function resolveFallbackStepName(ms: MissionStep): string {
  const chain = parseBuilderChain(ms.function_name ?? '', ms.arguments ?? []);
  if (!chain) {
    return (ms.function_name ?? '').trim();
  }

  if (chain.links.length === 1 && chain.links[0]?.methodName === 'until') {
    const color = extractUntilConditionColor(chain.links[0].args);
    return color ? `${chain.baseName}_until_${color}` : `${chain.baseName}.until`;
  }

  return `${chain.baseName}.${chain.links.map(link => link.methodName).join('.')}`;
}

function resolveFallbackArgName(ms: MissionStep, explicitName: string | undefined | null, index: number): string {
  if (explicitName && explicitName.trim()) {
    return explicitName;
  }

  const chain = parseBuilderChain(ms.function_name ?? '', ms.arguments ?? []);
  if (chain?.links.at(-1)?.methodName === 'until') {
    return index === 0 ? 'condition' : `condition${index}`;
  }

  return `arg${index}`;
}

function parseBuilderChain(functionName: string, terminalArgs: MissionStep['arguments']): BuilderChain | null {
  const trimmed = functionName.trim();
  if (!trimmed.includes('.')) {
    return null;
  }

  const segments = splitTopLevel(trimmed, '.')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }

  const baseSegment = parseBuilderSegment(segments[0], true);
  if (!baseSegment) {
    return null;
  }

  const links: BuilderChainLink[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const segment = parseBuilderSegment(segments[index], false);
    if (!segment) {
      return null;
    }
    links.push({
      methodName: segment.name,
      args: segment.args,
    });
  }

  if (links.length) {
    const lastLink = links[links.length - 1];
    if (!lastLink.args.length && terminalArgs?.length) {
      lastLink.args = missionArgsToBuilderTokens(terminalArgs);
    }
  }

  return {
    baseName: baseSegment.name,
    baseArgs: baseSegment.args,
    links,
  };
}

function parseBuilderSegment(
  segment: string,
  requireCallSyntax: boolean
): { name: string; args: BuilderArgToken[] } | null {
  const trimmed = segment.trim();
  if (!trimmed) {
    return null;
  }

  const openIndex = trimmed.indexOf('(');
  if (openIndex === -1) {
    return requireCallSyntax ? null : { name: trimmed, args: [] };
  }

  if (!trimmed.endsWith(')')) {
    return null;
  }

  const name = trimmed.slice(0, openIndex).trim();
  if (!name) {
    return null;
  }

  return {
    name,
    args: parseBuilderArgumentList(trimmed.slice(openIndex + 1, -1)),
  };
}

function missionArgsToBuilderTokens(argumentsList: MissionStep['arguments']): BuilderArgToken[] {
  return (argumentsList ?? []).map((arg) => ({
    binding: normalizeBuilderBinding(arg.type, arg.name),
    name: arg.name?.trim() ? arg.name : null,
    value: toMissionArgValue(arg.value),
  }));
}

function parseBuilderArgumentList(rawArgs: string): BuilderArgToken[] {
  return splitTopLevel(rawArgs, ',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
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

function buildBaseBuilderArgDefs(chain: BuilderChain, baseMatch: Step | undefined): StepArgDef[] {
  if (!baseMatch) {
    return chain.baseArgs.map((arg, index) => ({
      name: arg.name || `arg${index}`,
      label: arg.name || `arg${index}`,
      type: resolveMissionArgumentType(undefined, arg.value),
      default: arg.value,
      builderSource: 'base',
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
    return {
      ...def,
      label: def.label ?? def.name,
      type: resolveBuilderArgumentType(source?.value ?? def.default ?? null, def.type),
      default: source?.value ?? def.default ?? null,
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
      label: entry.arg.name || `arg${baseMatch.arguments.length + index}`,
      type: resolveMissionArgumentType(undefined, entry.arg.value),
      default: entry.arg.value,
      builderSource: 'base' as const,
      builderBinding: entry.arg.binding,
      builderRawName: entry.arg.name,
    }));

  return [...defs, ...remaining];
}

function buildChainMethodCatalog(baseMatch: Step | undefined, links: BuilderChainLink[]): StepChainMethod[] {
  const rootMethods = cloneChainMethods(stepChainMethods(baseMatch));
  if (!links.length) {
    return rootMethods;
  }

  let methods = rootMethods;
  links.forEach(link => {
    let matched = methods.find(method => method.name === link.methodName);
    if (!matched) {
      matched = {
        name: link.methodName,
        arguments: buildFallbackMethodArgDefs(link.methodName, link.args, 0, [], []).map(def => ({
          name: def.builderRawName ?? def.label ?? def.name,
          type: def.type,
          default: def.default,
        })),
      } as StepChainMethod;
      methods.push(matched);
    }

    const children = chainMethodChildren(matched);
    methods = children.length ? children : [];
  });

  return rootMethods;
}

function buildChainSelections(
  chain: BuilderChain,
  rootMethods: StepChainMethod[],
  baseArgs: StepArgDef[]
): StepChainSelection[] {
  const selections: StepChainSelection[] = [];
  let methods = rootMethods;

  chain.links.forEach((link, index) => {
    const matched = methods.find(method => method.name === link.methodName);
    const selection = matched
      ? {
        methodName: matched.name,
        arguments: buildMethodArgDefsFromCatalog(matched, index, baseArgs, selections),
      }
      : {
        methodName: link.methodName,
        arguments: buildFallbackMethodArgDefs(link.methodName, link.args, index, baseArgs, selections),
      };

    if (matched) {
      selection.arguments = mergeBuilderArgDefaults(selection.arguments, link.args);
    }

    selections.push(selection);

    if (matched) {
      const children = chainMethodChildren(matched);
      methods = children.length ? children : rootMethods;
    } else {
      methods = [];
    }
  });

  return selections;
}

function mergeBuilderArgDefaults(defs: StepArgDef[], sourceArgs: BuilderArgToken[]): StepArgDef[] {
  if (!sourceArgs.length) {
    return defs;
  }

  const used = new Set<number>();
  const merged = defs.map((def, index) => {
    const sourceIndex = findBestBuilderTokenIndex(
      sourceArgs,
      def.builderRawName ?? def.label ?? def.name,
      index,
      used
    );
    if (sourceIndex !== -1) {
      used.add(sourceIndex);
    }
    const source = sourceIndex !== -1 ? sourceArgs[sourceIndex] : undefined;
    if (!source) {
      return def;
    }

    return {
      ...def,
      type: resolveBuilderArgumentType(source.value, def.type),
      default: source.value,
      builderBinding: source.binding,
      builderRawName: source.binding === 'keyword'
        ? (source.name ?? def.builderRawName ?? def.label ?? def.name)
        : null,
    };
  });

  const chainIndex = merged[0]?.builderChainIndex ?? 0;
  const methodName = merged[0]?.builderMethodName ?? 'method';
  const extras = sourceArgs
    .map((arg, index) => ({ arg, index }))
    .filter(entry => !used.has(entry.index))
    .map((entry) => ({
      name: buildUniqueMethodArgKey(
        entry.arg.name || resolveMethodArgDisplayLabel(methodName, entry.index, sourceArgs.length),
        methodName,
        chainIndex,
        merged
      ),
      label: entry.arg.name || resolveMethodArgDisplayLabel(methodName, entry.index, sourceArgs.length),
      type: resolveMissionArgumentType(undefined, entry.arg.value),
      default: entry.arg.value,
      builderSource: 'method' as const,
      builderBinding: entry.arg.binding,
      builderRawName: entry.arg.name,
      builderChainIndex: chainIndex,
      builderMethodName: methodName,
    }));

  return [...merged, ...extras];
}

function buildMethodArgDefsFromCatalog(
  method: StepChainMethod,
  chainIndex: number,
  baseArgs: StepArgDef[],
  previousSelections: StepChainSelection[],
  existing?: StepArgDef[]
): StepArgDef[] {
  const existingByRawName = new Map(
    (existing ?? []).map(def => [normalizeArgName(def.builderRawName ?? def.label ?? def.name), def])
  );

  return method.arguments.map((arg, index) => {
    const keyLabel = arg.label ?? arg.name;
    const previousDef = existingByRawName.get(normalizeArgName(keyLabel)) ?? existing?.[index];
    return {
      ...arg,
      name: previousDef?.name ?? buildUniqueMethodArgKey(keyLabel, method.name, chainIndex, [
        ...baseArgs,
        ...previousSelections.flatMap(selection => selection.arguments),
      ]),
      label: keyLabel,
      type: previousDef?.type ?? arg.type,
      default: previousDef?.default ?? arg.default ?? null,
      builderSource: 'method',
      builderBinding: previousDef?.builderBinding ?? defaultMethodArgBinding(method.arguments.length, index),
      builderRawName: previousDef?.builderRawName ?? keyLabel,
      builderChainIndex: chainIndex,
      builderMethodName: method.name,
    };
  });
}

function buildFallbackMethodArgDefs(
  methodName: string,
  tokens: BuilderArgToken[],
  chainIndex: number,
  baseArgs: StepArgDef[],
  previousSelections: StepChainSelection[]
): StepArgDef[] {
  return tokens.map((arg, index) => {
    const label = arg.name || resolveMethodArgDisplayLabel(methodName, index, tokens.length);
    return {
      name: buildUniqueMethodArgKey(label, methodName, chainIndex, [
        ...baseArgs,
        ...previousSelections.flatMap(selection => selection.arguments),
      ]),
      label,
      type: resolveMissionArgumentType(undefined, arg.value),
      default: arg.value,
      builderSource: 'method',
      builderBinding: arg.binding,
      builderRawName: arg.name,
      builderChainIndex: chainIndex,
      builderMethodName: methodName,
    };
  });
}

function buildUniqueMethodArgKey(
  label: string,
  methodName: string,
  chainIndex: number,
  existingDefs: StepArgDef[]
): string {
  const normalizedLabel = (label || methodName || 'arg').trim() || 'arg';
  const used = new Set(existingDefs.map(def => def.name));
  if (!used.has(normalizedLabel)) {
    return normalizedLabel;
  }

  const base = `${methodName}_${chainIndex + 1}_${normalizedLabel}`;
  if (!used.has(base)) {
    return base;
  }

  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}

function defaultMethodArgBinding(totalArgs: number, index: number): 'keyword' | 'positional' {
  return totalArgs === 1 && index === 0 ? 'positional' : 'keyword';
}

function resolveMethodArgDisplayLabel(methodName: string, index: number, total: number): string {
  if (methodName === 'until') {
    return index === 0 ? 'condition' : `condition${index}`;
  }
  if (total === 1) {
    return methodName;
  }
  return `${methodName}${index}`;
}

function extractBaseBuilderArgDefs(step: Step): StepArgDef[] {
  const explicitBaseArgs = (step.arguments ?? []).filter(arg => arg.builderSource !== 'method');
  if (explicitBaseArgs.length) {
    return cloneArgDefs(explicitBaseArgs);
  }
  if ((step.arguments ?? []).some(arg => arg.builderSource === 'method')) {
    return [];
  }

  return (step.arguments ?? []).map(arg => ({
    ...arg,
    label: arg.label ?? arg.name,
    builderSource: 'base',
    builderBinding: arg.builderBinding ?? 'keyword',
    builderRawName: arg.builderRawName ?? arg.name,
  }));
}

function flattenBuilderArguments(baseArgs: StepArgDef[], selections: StepChainSelection[]): StepArgDef[] {
  return [
    ...cloneArgDefs(baseArgs),
    ...selections.flatMap(selection => cloneArgDefs(selection.arguments)),
  ];
}

function effectiveChainSelections(step: Step | null | undefined): StepChainSelection[] {
  if (!step) {
    return [];
  }

  if (step.chainSelections?.length) {
    return cloneChainSelections(step.chainSelections);
  }

  const methodArgs = (step.arguments ?? []).filter(arg => arg.builderSource === 'method');
  if (!methodArgs.length) {
    return [];
  }

  const grouped = new Map<number, StepArgDef[]>();
  methodArgs.forEach(arg => {
    const key = arg.builderChainIndex ?? 0;
    const existing = grouped.get(key) ?? [];
    existing.push({ ...arg });
    grouped.set(key, existing);
  });

  return Array.from(grouped.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([, args]) => ({
      methodName: args[0]?.builderMethodName ?? step.builderMethodName ?? 'method',
      arguments: args,
    }));
}

function cloneArgDefs(args: StepArgDef[]): StepArgDef[] {
  return (args ?? []).map(arg => ({ ...arg }));
}

function cloneChainSelections(selections: StepChainSelection[]): StepChainSelection[] {
  return (selections ?? []).map(selection => ({
    methodName: selection.methodName,
    arguments: cloneArgDefs(selection.arguments),
  }));
}

function cloneChainMethods(methods: StepChainMethod[]): StepChainMethod[] {
  return (methods ?? []).map(method => ({
    ...method,
    arguments: cloneArgDefs(method.arguments),
    chainMethods: cloneChainMethods(chainMethodChildren(method)),
  }));
}

function serializeBuilderStep(
  step: Step,
  args: Record<string, boolean | string | number | null>,
  fallbackText: string
): SerializedBuilderStep {
  const baseName = step.builderBaseName ?? step.name;
  const selections = effectiveChainSelections(step);

  if (!selections.length) {
    const plainArguments = extractBaseBuilderArgDefs(step).map(arg => ({
      name: arg.builderRawName ?? arg.label ?? arg.name,
      value: toMissionArgValue(args[arg.name]),
      type: arg.type ?? 'str',
    }));

    return {
      functionName: baseName,
      stepType: lc(baseName) === 'parallel' ? 'parallel' : '',
      arguments: plainArguments,
      text: baseName || fallbackText,
    };
  }

  const baseArgs = extractBaseBuilderArgDefs(step)
    .flatMap(arg => {
      const value = toMissionArgValue(args[arg.name]);
      if (value == null || value === '') {
        return [];
      }
      return [formatBuilderArgument(
        arg.builderBinding ?? 'keyword',
        arg.builderBinding === 'keyword' ? (arg.builderRawName ?? arg.label ?? arg.name) : null,
        value
      )];
    });

  const linkExpressions = selections.map((selection, index) => {
    const methodArgs = selection.arguments
      .flatMap(arg => {
        const value = toMissionArgValue(args[arg.name]);
        if (value == null || value === '') {
          return [];
        }
        return [formatBuilderArgument(
          arg.builderBinding ?? defaultMethodArgBinding(selection.arguments.length, 0),
          arg.builderBinding === 'keyword' ? (arg.builderRawName ?? arg.label ?? arg.name) : null,
          value
        )];
      });

    if (index === selections.length - 1) {
      return {
        name: selection.methodName,
        expression: selection.methodName,
        arguments: selection.arguments
          .map(arg => ({
            name: (arg.builderBinding ?? 'positional') === 'keyword'
              ? (arg.builderRawName ?? arg.label ?? arg.name)
              : '',
            value: toMissionArgValue(args[arg.name]),
            type: arg.builderBinding ?? defaultMethodArgBinding(selection.arguments.length, 0),
          }))
          .filter(arg => arg.value != null && arg.value !== ''),
      };
    }

    return {
      name: selection.methodName,
      expression: `${selection.methodName}(${methodArgs.join(', ')})`,
      arguments: [] as MissionStep['arguments'],
    };
  });

  const functionName = `${baseName}(${baseArgs.join(', ')})${linkExpressions.length ? '.' : ''}${linkExpressions.map(link => link.expression).join('.')}`;
  const nodeText = resolveBuilderDisplayName(step, args) || fallbackText || functionName;

  return {
    functionName,
    stepType: functionName,
    arguments: linkExpressions.at(-1)?.arguments ?? [],
    text: nodeText,
  };
}

function extractUntilConditionColorFromSelection(
  selection: StepChainSelection,
  args: Record<string, boolean | string | number | null>
): 'black' | 'white' | null {
  for (const arg of selection.arguments ?? []) {
    const value = args[arg.name];
    if (typeof value !== 'string') {
      continue;
    }
    const match = /\bon_(black|white)\s*\(/i.exec(value);
    if (match?.[1]) {
      return match[1].toLowerCase() as 'black' | 'white';
    }
  }
  return null;
}

function extractUntilConditionColor(tokens: BuilderArgToken[]): 'black' | 'white' | null {
  for (const token of tokens) {
    if (typeof token.value !== 'string') {
      continue;
    }
    const match = /\bon_(black|white)\s*\(/i.exec(token.value);
    if (match?.[1]) {
      return match[1].toLowerCase() as 'black' | 'white';
    }
  }
  return null;
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
  return normalized === 'keyword' ||
    normalized === 'kw' ||
    normalized === 'named' ||
    normalized === 'named_argument' ||
    normalized === 'positional' ||
    normalized === 'pos' ||
    normalized === 'position';
};

function normalizeBuilderBinding(type: string | undefined | null, name: string | undefined | null): 'keyword' | 'positional' {
  if (isBindingArgType(type)) {
    return normalizeArgType(type).startsWith('key') || normalizeArgType(type).startsWith('named')
      ? 'keyword'
      : 'positional';
  }
  return name ? 'keyword' : 'positional';
}

function resolveBuilderArgumentType(value: unknown, fallbackType?: string | null): string {
  if (value !== null && value !== undefined && value !== '') {
    return resolveMissionArgumentType(undefined, value);
  }
  return resolveMissionArgumentType(fallbackType, value);
}

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

    const normalizedStoredName = normalizeArgName(arg.name);
    let score = -1;

    if (argNamesEquivalent(arg.name, defName)) {
      score = normalizedStoredName === normalizedDefName ? 2 : 1;
      if (hasConcreteArgValue(arg.value)) {
        score += 3;
      }
    } else if (fallbackIndex >= 0 && index === fallbackIndex && isGenericArgName(arg.name)) {
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
  const index = findBestStoredArgIndex(sourceArgs, defName, fallbackIndex, usedIndices);
  return index !== -1 ? sourceArgs[index] : undefined;
}

function toMissionArgValue(value: unknown): string | number | boolean | null {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

export function canonicalizeMissionStepArguments(ms: MissionStep, pool: Step[]): MissionStep {
  const match = pool.find(step => step.name === ms.function_name);
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
