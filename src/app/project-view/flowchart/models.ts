import { MissionStep } from '../../entities/MissionStep';

// Shared models and helpers for the flowchart component

export interface Connection {
  id: string;
  outputId: string;
  inputId: string;
  sourceNodeId?: string | null;
  targetNodeId?: string | null;
  targetPathKey?: string | null;
  hasBreakpoint?: boolean;
  breakpointPathKey?: string | null;
}

export interface FlowNode {
  id: string;
  text: string;
  position: { x: number; y: number };
  step: Step;
  args: Record<string, boolean | string | number | null>;
  path?: number[];
}

export interface FlowComment {
  id: string;
  position: { x: number; y: number };
  text: string;
  beforePath?: string | null;
  afterPath?: string | null;
}

export interface FlowGroup {
  id: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  title: string;
  collapsed: boolean;
  nodeIds: string[];
  stepPaths: string[];
  expandedSize?: { width: number; height: number } | null;
}

export type FlowOrientation = 'vertical' | 'horizontal';

// The `Step` interface is provided by the steps state domain at runtime.
// We declare a minimal shape here to keep helpers typed.
export interface StepArgDef {
  name: string;
  type: string;
  default?: unknown;
}

export interface Step {
  name: string;
  import?: string | null;
  file?: string;
  optional?: boolean;
  arguments: StepArgDef[];
  tags?: string[];
}

const normalizedArgType = (type?: string | null) => (type ?? '').replace(/\s+/g, '').toLowerCase();

export const isMultiSensorType = (type?: string | null): boolean => {
  const normalized = normalizedArgType(type);
  return normalized.includes('list[irsensor]') && normalized.includes('irsensor');
};

export const resolveDefinitionType = (type?: string | null): string => {
  if (isMultiSensorType(type)) {
    return 'IRSensor';
  }
  return (type ?? '').trim();
};

export const parseMultiSensorSelection = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map(item => (typeof item === 'string' ? item.trim() : String(item).trim()))
      .filter(item => item.length > 0);
  }
  if (typeof value !== 'string') {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner
      .split(',')
      .map(part => part.trim().replace(/^['"]|['"]$/g, ''))
      .filter(part => part.length > 0);
  }
  if (trimmed.includes(',')) {
    return trimmed
      .split(',')
      .map(part => part.trim())
      .filter(part => part.length > 0);
  }
  return [trimmed];
};

export const serializeMultiSensorSelection = (value: unknown): string | null => {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }

  const unique = Array.from(
    new Set(
      parseMultiSensorSelection(value).map(sensor => sensor.trim()).filter(sensor => sensor.length > 0)
    )
  );
  if (!unique.length) {
    return null;
  }
  if (unique.length === 1) {
    return unique[0];
  }
  return `[${unique.join(', ')}]`;
};

export const lc = (s?: string | null) => (s ?? '').toLowerCase();
export const isType = (s: MissionStep | null | undefined, t: 'parallel' | 'seq' | 'breakpoint') => !!s && (lc(s.function_name) === t || lc(s.step_type) === t);
export const isBreakpoint = (s: MissionStep | null | undefined) => isType(s, 'breakpoint');
export const mk = (t: 'parallel' | 'seq'): MissionStep => ({
  step_type: t,
  function_name: t,
  arguments: [],
  position: { x: 0, y: 0 },
  children: [],
});
export const baseId = (id: string, kind: 'input' | 'output') => kind === 'output' ? (id === 'start-node-output' ? 'start-node' : id.replace(/-output$/, '')) : id.replace(/-input$/, '');
const toNumber = (input: unknown) => {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : null;
  }
  if (typeof input === 'string' && input.trim() !== '') {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export const toVal = (t: string | undefined, v: unknown) => {
  if (v == null || v === '') {
    return null;
  }
  const kind = (t ?? '').toLowerCase();
  if (kind === 'bool' || kind === 'boolean') {
    return typeof v === 'boolean' ? v : String(v).toLowerCase() === 'true';
  }
  if (kind === 'float' || kind === 'number') {
    const parsed = toNumber(v);
    return parsed === null ? null : parsed;
  }
  if (kind === 'int' || kind === 'integer') {
    const parsed = toNumber(v);
    return parsed === null ? null : Math.trunc(parsed);
  }
  return typeof v === 'string' ? v : String(v);
};
