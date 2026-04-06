import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { generateGuid } from '@foblex/utils';
import { Connection, FlowNode, Step, baseId, isBreakpoint, isType } from './models';
import { START_NODE_ID, END_NODE_ID, END_INPUT_ID } from './constants';

export interface ParallelGroupInfo {
  pathKey: string;
  nodeIds: string[];
}

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
  parallelGroups: ParallelGroupInfo[];
} {
  const nodes: FlowNode[] = [];
  const conns: Connection[] = [];
  const stepToNodeId = new Map<MissionStep, string>();
  const nodeIdToStep = new Map<string, MissionStep>();
  const pathToNodeId = new Map<string, string>();
  const pathToConnectionIds = new Map<string, string[]>();
  const visitedSteps = new Set<MissionStep>();
  const parallelGroups: ParallelGroupInfo[] = [];

  type ExitRef = { id: string; breakpointPathKey?: string | null };
  const toPathKey = (path?: number[]) => (path && path.length ? path.join('.') : null);
  const registerPathConnection = (pathKey: string | null, connectionId: string) => {
    if (!pathKey) {
      return;
    }
    const existing = pathToConnectionIds.get(pathKey) ?? [];
    existing.push(connectionId);
    pathToConnectionIds.set(pathKey, existing);
  };

  const pushConnection = (
    exit: ExitRef,
    inputId: string,
    targetNodeId: string | null,
    targetPathKey: string | null
  ) => {
    const connId = generateGuid();
    const sourceNode = baseId(exit.id, 'output');
    const connection: Connection = {
      id: connId,
      outputId: exit.id,
      inputId,
      sourceNodeId: sourceNode === START_NODE_ID ? null : sourceNode,
      targetNodeId,
      targetPathKey,
    };
    const breakpointPathKey = exit.breakpointPathKey ?? null;
    if (breakpointPathKey) {
      connection.hasBreakpoint = true;
      connection.breakpointPathKey = breakpointPathKey;
    }
    conns.push(connection);
    registerPathConnection(targetPathKey, connId);
  };

  const estimateJunctionPosition = (exits: ExitRef[]): { x: number; y: number } => {
    const refs = exits
      .map(exit => {
        const nodeId = baseId(exit.id, 'output');
        return nodes.find(node => node.id === nodeId)?.position;
      })
      .filter((pos): pos is { x: number; y: number } => !!pos);

    if (!refs.length) {
      return { x: 300, y: 120 };
    }

    const x = refs.reduce((sum, pos) => sum + pos.x, 0) / refs.length;
    const y = Math.max(...refs.map(pos => pos.y)) + 110;
    return { x, y };
  };

  const createParallelJunction = (exits: ExitRef[]): ExitRef => {
    const junctionId = `junction-${generateGuid()}`;
    const junctionInputId = `${junctionId}-input`;
    const junctionOutputId = `${junctionId}-output`;
    nodes.push({
      id: junctionId,
      text: '',
      position: estimateJunctionPosition(exits),
      step: { name: '__junction__', arguments: [] },
      args: {},
    });

    exits.forEach(exit => {
      pushConnection(exit, junctionInputId, junctionId, null);
    });

    const mergedBreakpointPathKey = exits.find(exit => !!exit.breakpointPathKey)?.breakpointPathKey ?? null;
    return mergedBreakpointPathKey
      ? { id: junctionOutputId, breakpointPathKey: mergedBreakpointPathKey }
      : { id: junctionOutputId };
  };

  const build = (
    steps: MissionStep[],
    parentExits: ExitRef[]
  ): { entryRefs: ExitRef[]; exitRefs: ExitRef[] } => {
    const entries: ExitRef[] = [];
    const exits: ExitRef[] = [];
    for (let idx = 0; idx < steps.length; idx += 1) {
      const s = steps[idx];
      if (visitedSteps.has(s)) {
        continue;
      }
      visitedSteps.add(s);
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
        const children = s.children ?? [];
        if (children.length > 1) {
          // Create fork junction: single entry point for the parallel
          const forkExit = createParallelJunction(parentExits);
          const forkId = baseId(forkExit.id, 'output');
          const nodesBefore = nodes.length;
          const r = build(children, [forkExit]);
          // Create join junction: single exit point for the parallel
          const childExits = r.exitRefs.length ? r.exitRefs : [forkExit];
          const joinExit = createParallelJunction(childExits);
          const joinId = baseId(joinExit.id, 'output');
          // Collect all nodes (including fork/join) for auto-grouping
          if (pathKey) {
            const groupNodeIds: string[] = [forkId];
            for (let ni = nodesBefore; ni < nodes.length; ni++) {
              if (nodes[ni].id !== forkId) {
                groupNodeIds.push(nodes[ni].id);
              }
            }
            if (!groupNodeIds.includes(joinId)) groupNodeIds.push(joinId);
            parallelGroups.push({ pathKey, nodeIds: groupNodeIds });
          }
          if (r.entryRefs.length) entries.push(...r.entryRefs);
          exits.push(joinExit);
        } else {
          // Single child: no fork/join needed
          const r = build(children, parentExits);
          if (r.entryRefs.length) entries.push(...r.entryRefs);
          exits.push(...(r.exitRefs.length ? r.exitRefs : parentExits));
        }
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
      const step = asStep(s);
      stepToNodeId.set(s, id);
      nodeIdToStep.set(id, s);
      const inputId = `${id}-input`;
      const outputId = `${id}-output`;
      nodes.push({
        id,
        text: step.name || s.function_name,
        position: {
          x: s.position?.x ?? 0,
          y: s.position?.y ?? 0,
        },
        step,
        args: initialArgs(s),
        path,
      });
      if (pathKey) {
        pathToNodeId.set(pathKey, id);
      }
      parentExits.forEach(exit => {
        pushConnection(exit, inputId, id, pathKey ?? null);
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

  // Connect all final exits to the end node
  for (const exit of exits) {
    pushConnection(exit, END_INPUT_ID, END_NODE_ID, null);
  }

  return { nodes, connections: conns, stepToNodeId, nodeIdToStep, pathToNodeId, pathToConnectionIds, parallelGroups };
}
