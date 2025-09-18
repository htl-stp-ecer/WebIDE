import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { Connection, FlowNode, Step } from './models';
import { generateGuid } from '@foblex/utils';
import { isType } from './models';

export function rebuildMissionView(
  mission: Mission,
  oldStepToNodeId: Map<MissionStep, string>,
  asStep: (ms: MissionStep) => Step,
  initialArgs: (ms: MissionStep) => Record<string, boolean | string | number | null>,
  startOutputId: string
): {
  nodes: FlowNode[];
  connections: Connection[];
  stepToNodeId: Map<MissionStep, string>;
  nodeIdToStep: Map<string, MissionStep>;
} {
  const nodes: FlowNode[] = [];
  const conns: Connection[] = [];
  const stepToNodeId = new Map<MissionStep, string>();
  const nodeIdToStep = new Map<string, MissionStep>();

  const build = (
    steps: MissionStep[],
    parentExits: string[]
  ): { entryIds: string[]; exitIds: string[] } => {
    const entries: string[] = [];
    const exits: string[] = [];
    for (const s of steps) {
      if (isType(s, 'seq')) {
        let incoming = parentExits;
        const first: string[] = [];
        let last: string[] = incoming;
        (s.children ?? []).forEach((ch, i) => {
          const r = build([ch], incoming);
          if (i === 0) first.push(...r.entryIds);
          incoming = last = r.exitIds;
        });
        if (first.length) entries.push(...first);
        exits.push(...(last.length ? last : parentExits));
        continue;
      }
      if (isType(s, 'parallel')) {
        const r = build(s.children ?? [], parentExits);
        entries.push(...r.entryIds);
        exits.push(...r.exitIds);
        continue;
      }

      const id = oldStepToNodeId.get(s) ?? generateGuid();
      stepToNodeId.set(s, id);
      nodeIdToStep.set(id, s);
      const inputId = `${id}-input`;
      const outputId = `${id}-output`;
      nodes.push({
        id,
        text: s.function_name,
        position: { x: 0, y: 0 },
        step: asStep(s),
        args: initialArgs(s),
      });
      parentExits.forEach((pid) => conns.push({ id: generateGuid(), outputId: pid, inputId }));
      const childExit = s.children?.length ? build(s.children, [outputId]).exitIds : [outputId];
      entries.push(inputId);
      exits.push(...childExit);
    }
    return { entryIds: entries, exitIds: exits };
  };

  let exits: string[] = [startOutputId];
  for (const top of mission.steps) exits = build([top], exits).exitIds;

  return { nodes, connections: conns, stepToNodeId, nodeIdToStep };
}

