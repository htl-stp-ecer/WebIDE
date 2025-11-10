import type { Flowchart } from './flowchart';
import type { FlowNode } from './models';
import type { MissionStep } from '../../entities/MissionStep';

type ArgPrimitive = string | number | boolean | null;

export function handleArgumentChange(flow: Flowchart, nodeId: string, argName: string, argIndex: number, rawValue: unknown): void {
  const node = findNode(flow, nodeId);
  const argKey = argName;
  const storedName = argKey || `arg${argIndex}`;
  const argType = node?.step?.arguments?.[argIndex]?.type;
  const resolvedValue = resolveControlValue(rawValue, argType);
  const persistedValue = resolvedValue == null ? '' : String(resolvedValue);
  const currentValue = node?.args?.[argKey] ?? null;

  if (node) {
    if (!node.args) node.args = {};
    node.args[argKey] = resolvedValue;
  }

  let changed = !valuesEqual(currentValue, resolvedValue);
  const missionStep = flow.lookups.nodeIdToStep.get(nodeId);

  if (missionStep) {
    const targetArg = ensureMissionArgument(missionStep, argIndex, storedName, argType);
    if (!changed) {
      changed = !valuesEqual(normalizeStoredValue(targetArg.value), persistedValue);
    }
    if (!changed) {
      return;
    }
    targetArg.value = persistedValue as any;
    flow.historyManager.recordHistory('update-argument');
    return;
  }

  if (!changed) {
    return;
  }

  const adHocNodes = flow.adHocNodes();
  const idx = adHocNodes.findIndex(n => n.id === nodeId);
  if (idx !== -1) {
    adHocNodes[idx].args = { ...(adHocNodes[idx].args ?? {}), [argKey]: resolvedValue };
  }
  flow.historyManager.recordHistory('update-argument');
}

function findNode(flow: Flowchart, nodeId: string): FlowNode | undefined {
  return flow.nodes().find(n => n.id === nodeId);
}

function resolveControlValue(value: unknown, argType?: string): ArgPrimitive {
  const unwrapped = unwrapOptionValue(value);
  if (unwrapped == null || unwrapped === '') {
    return null;
  }
  const kind = (argType ?? '').toLowerCase();
  if (kind === 'bool' || kind === 'boolean') {
    return unwrapped === true || unwrapped === 'true';
  }
  if (kind === 'float' || kind === 'number' || kind === 'int' || kind === 'integer') {
    if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) {
      return unwrapped;
    }
    const parsed = Number(unwrapped);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return String(unwrapped);
}

function unwrapOptionValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) {
    return (value as Record<string, unknown>)['value'];
  }
  return value;
}

function ensureMissionArgument(step: MissionStep, index: number, name: string, argType?: string) {
  step.arguments ??= [];
  if (!step.arguments[index]) {
    step.arguments[index] = {
      name,
      value: '',
      type: argType ?? 'str',
    };
  } else {
    if (name && !step.arguments[index].name) {
      step.arguments[index].name = name;
    }
    if (argType && !step.arguments[index].type) {
      step.arguments[index].type = argType;
    }
  }
  return step.arguments[index];
}

function normalizeStoredValue(value: unknown): string {
  return value == null ? '' : String(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  return false;
}
