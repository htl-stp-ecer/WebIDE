import { MissionStep } from '../../entities/MissionStep';
import { FlowNode, Step, toVal, lc } from './models';

export function asStepFromPool(ms: MissionStep, pool: Step[]): Step {
  const match = pool.find(s => s.name === ms.function_name);
  return match ?? {
    name: ms.function_name,
    import: '',
    arguments: ms.arguments.map((a, i) => ({
      name: a.name || `arg${i}`,
      type: a.type,
      import: null as any,
      optional: false,
      default: a.value
    })),
    file: ''
  } as Step;
}

export function initialArgsFromPool(ms: MissionStep, pool: Step[]): Record<string, boolean | string | number | null> {
  const match = pool.find(s => s.name === ms.function_name);
  return match
    ? Object.fromEntries(match.arguments.map((sa, i) => [sa.name, toVal(sa.type, String(ms.arguments[i]?.value ?? sa.default ?? ''))]))
    : Object.fromEntries(ms.arguments.map((a, i) => [a.name || `arg${i}`, toVal(a.type, String(a.value ?? ''))]));
}

export function missionStepFromAdHoc(n: FlowNode): MissionStep {
  const args = Object.entries(n.args || {}).map(([name, v]) => ({
    name,
    value: v == null ? '' : String(v),
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
