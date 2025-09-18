import { MissionStep } from '../../entities/MissionStep';

// Shared models and helpers for the flowchart component

export type Connection = { id: string; outputId: string; inputId: string };

export interface FlowNode {
  id: string;
  text: string;
  position: { x: number; y: number };
  step: Step;
  args: Record<string, boolean | string | number | null>;
}

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
}

export const lc = (s?: string | null) => (s ?? '').toLowerCase();
export const isType = (s: MissionStep | null | undefined, t: 'parallel' | 'seq') => !!s && (lc(s.function_name) === t || lc(s.step_type) === t);
export const mk = (t: 'parallel' | 'seq'): MissionStep => ({ step_type: t, function_name: t, arguments: [], children: [] });
export const baseId = (id: string, kind: 'input' | 'output') => kind === 'output' ? (id === 'start-node-output' ? 'start-node' : id.replace(/-output$/, '')) : id.replace(/-input$/, '');
export const toVal = (t: string, v: string) => t === 'bool' ? v.toLowerCase() === 'true' : t === 'float' ? (parseFloat(v) || null) : v;

