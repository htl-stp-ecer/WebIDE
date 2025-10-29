import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { generateGuid } from '@foblex/utils';
import { Connection, FlowNode, Step, baseId, isBreakpoint, isType } from './models';
import { START_NODE_ID } from './constants';

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

  type ExitRef = { id: string; breakpointPathKey?: string | null };
  const toPathKey = (path?: number[]) => (path && path.length ? path.join('.') : null);

  const build = (
    steps: MissionStep[],
    parentExits: ExitRef[]
  ): { entryRefs: ExitRef[]; exitRefs: ExitRef[] } => {
    const entries: ExitRef[] = [];
    const exits: ExitRef[] = [];
    for (let idx = 0; idx < steps.length; idx += 1) {
      const s = steps[idx];
      const path = resolvePath?.(s);
      const pathKey = toPathKey(path);
      if (isType(s, 'seq')) {
        let incoming = parentExits;
        const first: ExitRef[] = [];
        let last: ExitRef[] = incoming;
        (s.children ?? []).forEach((ch, i) => {
          const r = build([ch], incoming);
          if (i === 0 && r.entryRefs.length) first.push(...r.entryRefs);
          incoming = last = r.exitRefs;
        });
        if (first.length) entries.push(...first);
        exits.push(...(last.length ? last : parentExits));
        continue;
      }
      if (isType(s, 'parallel')) {
        const r = build(s.children ?? [], parentExits);
        if (r.entryRefs.length) entries.push(...r.entryRefs);
        exits.push(...(r.exitRefs.length ? r.exitRefs : parentExits));
        continue;
      }
      if (isBreakpoint(s)) {
        const breakpointExits = parentExits.map(exit => ({
          id: exit.id,
          breakpointPathKey: pathKey ?? exit.breakpointPathKey ?? null,
        }));
        const r = build(s.children ?? [], breakpointExits);
        if (r.entryRefs.length) entries.push(...r.entryRefs);
        exits.push(...(r.exitRefs.length ? r.exitRefs : breakpointExits));
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
      parentExits.forEach((exit) => {
        const connId = generateGuid();
        const sourceNode = baseId(exit.id, 'output');
        const connection: Connection = {
          id: connId,
          outputId: exit.id,
          inputId,
          sourceNodeId: sourceNode === START_NODE_ID ? null : sourceNode,
          targetNodeId: id,
          targetPathKey: pathKey ?? null,
        };
        const breakpointPathKey = exit.breakpointPathKey ?? null;
        if (breakpointPathKey) {
          connection.hasBreakpoint = true;
          connection.breakpointPathKey = breakpointPathKey;
        }
        conns.push(connection);
        if (pathKey) {
          const existing = pathToConnectionIds.get(pathKey) ?? [];
          existing.push(connId);
          pathToConnectionIds.set(pathKey, existing);
        }
      });
      const childResult = s.children?.length
        ? build(s.children, [{ id: outputId }])
        : { entryRefs: [] as ExitRef[], exitRefs: [{ id: outputId } as ExitRef] };
      entries.push({ id: inputId });
      exits.push(...(childResult.exitRefs.length ? childResult.exitRefs : [{ id: outputId }]));
    }
    return { entryRefs: entries, exitRefs: exits };
  };

  let exits: ExitRef[] = [{ id: startOutputId }];
  for (const top of mission.steps ?? []) exits = build([top], exits).exitRefs;

  return { nodes, connections: conns, stepToNodeId, nodeIdToStep, pathToNodeId, pathToConnectionIds };
}
