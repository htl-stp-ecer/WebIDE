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
  startOutputId: string,
  resolvePath?: (ms: MissionStep) => number[] | undefined,
): {
  nodes: FlowNode[];
  connections: Connection[];
  stepToNodeId: Map<MissionStep, string>;
  nodeIdToStep: Map<string, MissionStep>;
  pathToNodeId: Map<string, string>;
  pathToConnectionIds: Map<string, string[]>;
} {
  const nodes: FlowNode[] = [];
  const conns: Connection[] = [];
  const stepToNodeId = new Map<MissionStep, string>();
  const nodeIdToStep = new Map<string, MissionStep>();
  const pathToNodeId = new Map<string, string>();
  const pathToConnectionIds = new Map<string, string[]>();

  const build = (
    steps: MissionStep[],
    parentExits: string[]
  ): { entryIds: string[]; exitIds: string[] } => {
    const entries: string[] = [];
    const exits: string[] = [];
    for (let idx = 0; idx < steps.length; idx += 1) {
      const s = steps[idx];
      const path = resolvePath?.(s);
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
      const pathKey = path?.length ? path.join('.') : undefined;
      nodes.push({
        id,
        text: s.function_name,
        position: {
          x: s.position?.x ?? 0,
          y: s.position?.y ?? 0,
        },
        step: asStep(s),
        args: initialArgs(s),
        path,
      });
      if (pathKey) {
        pathToNodeId.set(pathKey, id);
      }
      parentExits.forEach((pid) => {
        const connId = generateGuid();
        conns.push({ id: connId, outputId: pid, inputId });
        if (pathKey) {
          const existing = pathToConnectionIds.get(pathKey) ?? [];
          existing.push(connId);
          pathToConnectionIds.set(pathKey, existing);
        }
      });
      const childExit = s.children?.length ? build(s.children, [outputId]).exitIds : [outputId];
      entries.push(inputId);
      exits.push(...childExit);
    }
    return { entryIds: entries, exitIds: exits };
  };

  let exits: string[] = [startOutputId];
  for (const top of mission.steps) exits = build([top], exits).exitIds;

  return { nodes, connections: conns, stepToNodeId, nodeIdToStep, pathToNodeId, pathToConnectionIds };
}
