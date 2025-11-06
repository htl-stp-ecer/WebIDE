import { signal } from '@angular/core';
import { FCreateConnectionEvent, FNodeIntersectedWithConnections } from '@foblex/flow';
import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { FlowNode, Connection, Step, baseId } from './models';
import { Flowchart } from './flowchart';
import { FlowchartLookupState } from './lookups';
import { handleAddConnection, handleNodeIntersected } from './connection-handlers';
import { recomputeMergedView } from './view-merger';
import { rebuildFromMission } from './mission-handlers';
import { insertBetween, attachChildSequentially } from './mission-sequence-utils';

const createStep = (
  name: string,
  args: { name: string; type: string; default?: unknown }[] = [],
  children: MissionStep[] = [],
  stepType = ''
): MissionStep => ({
  step_type: stepType,
  function_name: name,
  arguments: args.map(arg => ({ name: arg.name, value: String(arg.default ?? ''), type: arg.type })),
  position: { x: 0, y: 0 },
  children,
});

interface TestFlowchartDeps {
  mission: Mission;
  steps?: Step[];
}

const cloneMission = (mission: Mission): Mission => JSON.parse(JSON.stringify(mission));

const getStepByPath = (mission: Mission, path: number[] | undefined | null): MissionStep | null => {
  if (!path || !path.length) {
    return null;
  }
  let current: MissionStep | null = null;
  let currentChildren = mission.steps;
  for (const index of path) {
    const step = currentChildren?.[index - 1];
    if (!step) return null;
    current = step;
    currentChildren = step.children;
  }
  return current;
};

const createTestFlow = ({ mission, steps = [] }: TestFlowchartDeps) => {
  const missionSignal = signal<Mission | null>(mission);

  const missionState = {
    currentMission: missionSignal,
  };

  const stepsState = {
    currentSteps: () => steps,
  };

  const historyManager = {
    recordHistory: jasmine.createSpy('recordHistory'),
  };

  const runManager = {
    updatePathLookups: jasmine.createSpy('updatePathLookups'),
    clearRunVisuals: jasmine.createSpy('clearRunVisuals'),
  };

  const layoutFlags = {
    needsAdjust: false,
    pendingViewportReset: false,
    markViewportResetPending: () => { layoutFlags.pendingViewportReset = true; },
  } as any;

  const flow: Partial<Flowchart> = {
    missionState: missionState as any,
    stepsState: stepsState as any,
    historyManager: historyManager as any,
    runManager: runManager as any,
    layoutFlags,
    lookups: new FlowchartLookupState(),
    nodes: signal<FlowNode[]>([]),
    connections: signal<Connection[]>([]),
    missionNodes: signal<FlowNode[]>([]),
    missionConnections: signal<Connection[]>([]),
    adHocNodes: signal<FlowNode[]>([]),
    adHocConnections: signal<Connection[]>([]),
    comments: signal([]),
    orientation: signal<'vertical' | 'horizontal'>('vertical'),
  };

  return flow as Flowchart;
};

describe('connection-handlers', () => {
  describe('handleNodeIntersected', () => {
    it('inserts a dragged ad-hoc node between sequential steps', () => {
      const stepA = createStep('A');
      const stepB = createStep('B');
      const mission: Mission = {
        name: 'mission',
        is_setup: false,
        is_shutdown: false,
        order: 0,
        steps: [stepA, stepB],
        comments: [],
      };

      const flow = createTestFlow({ mission });

      rebuildFromMission(flow, mission);
      recomputeMergedView(flow);

      const adHocNode: FlowNode = {
        id: 'adhoc-1',
        text: 'X',
        position: { x: 0, y: 0 },
        step: { name: 'X', arguments: [] },
        args: {},
      };

      const adHocNodes = flow.adHocNodes();
      flow.adHocNodes.set([...adHocNodes, adHocNode]);
      recomputeMergedView(flow);

      const stepBNodeId = flow.lookups.stepToNodeId.get(stepB)!;
      const connection = flow.connections().find(c => c.targetNodeId === stepBNodeId);
      expect(connection).toBeTruthy();

      const event = new FNodeIntersectedWithConnections(adHocNode.id, [connection!.id]);

      handleNodeIntersected(flow, event);

      const missionSteps = mission.steps;
      expect(missionSteps.length).toBe(2);
      expect(missionSteps[0]).toBe(stepA);

      const parallelStep = missionSteps[1];
      expect(parallelStep.step_type).toBe('parallel');
      expect(parallelStep.children?.length).toBe(1);

      const insertedStep = parallelStep.children?.[0];
      expect(insertedStep?.function_name).toBe('X');
      expect(insertedStep?.children?.[0]).toBe(stepB);
      expect(flow.historyManager.recordHistory).toHaveBeenCalledWith('split-mission-connection');

      const adHocNode2: FlowNode = {
        id: 'adhoc-2',
        text: 'Y',
        position: { x: 0, y: 0 },
        step: { name: 'Y', arguments: [] },
        args: {},
      };

      flow.adHocNodes.set([adHocNode2]);
      recomputeMergedView(flow);

      const stepBNodeIdAfterFirstInsert = flow.lookups.stepToNodeId.get(stepB)!;
      const connectionToStepB = flow.connections().find(c => c.targetNodeId === stepBNodeIdAfterFirstInsert);
      expect(connectionToStepB).toBeTruthy();

      const event2 = new FNodeIntersectedWithConnections(adHocNode2.id, [connectionToStepB!.id]);
      handleNodeIntersected(flow, event2);

      const parallelAfterSecondInsert = mission.steps[1];
      const firstLaneStep = parallelAfterSecondInsert.children?.[0];
      expect(firstLaneStep?.function_name).toBe('X');
      const nestedInsertedStep = firstLaneStep?.children?.[0];
      expect(nestedInsertedStep?.function_name).toBe('Y');
      expect(nestedInsertedStep?.children?.[0]).toBe(stepB);
    });
  });

  it('successfully inserts between every connection in a sample mission', () => {
    const branchLeaf = createStep('Leaf');
    const parallelChild1 = createStep('Parallel-1');
    const parallelChild2 = createStep('Parallel-2', [], [branchLeaf]);
    const parallel = createStep('parallel', [], [parallelChild1, parallelChild2], 'parallel');
    const seqChild1 = createStep('Seq-1');
    const seqChild2 = createStep('Seq-2', [], [createStep('Seq-2-Child')]);
    const seq = createStep('seq', [], [seqChild1, parallel, seqChild2], 'seq');
    const parentWithChild = createStep('Parent-Child', [], [createStep('NestedChild')]);
    const topSequence = [
      createStep('Top-1'),
      parentWithChild,
      seq,
      createStep('Top-After'),
    ];

    const mission: Mission = {
      name: 'mission',
      is_setup: false,
      is_shutdown: false,
      order: 0,
      steps: topSequence,
      comments: [],
    };

    const flow = createTestFlow({ mission });
    rebuildFromMission(flow, mission);
    recomputeMergedView(flow);

    const connections = flow.missionConnections();
    expect(connections.length).toBeGreaterThan(0);

    const connectionInfos = connections.map(conn => {
      const parentNodeId = conn.sourceNodeId ?? (conn.outputId ? baseId(conn.outputId, 'output') : null);
      const childNodeId = conn.targetNodeId ?? (conn.inputId ? baseId(conn.inputId, 'input') : null);

      const parentStep = parentNodeId && parentNodeId !== 'start-node'
        ? flow.lookups.nodeIdToStep.get(parentNodeId) ?? null
        : null;
      const childStep = childNodeId ? flow.lookups.nodeIdToStep.get(childNodeId) ?? null : null;

      return {
        parentPath: parentStep ? flow.lookups.stepPaths.get(parentStep) ?? null : null,
        childPath: childStep ? flow.lookups.stepPaths.get(childStep) ?? null : null,
      };
    });

    connectionInfos.forEach((info, idx) => {
      const clonedMission = cloneMission(mission);
      const clonedFlow = createTestFlow({ mission: clonedMission });
      rebuildFromMission(clonedFlow, clonedMission);
      recomputeMergedView(clonedFlow);

      const parentStep = getStepByPath(clonedMission, info.parentPath);
      const childStep = getStepByPath(clonedMission, info.childPath);

      expect(childStep).withContext(`child step missing for connection ${idx}`).toBeTruthy();
      if (!childStep) {
        return;
      }

      const mid = createStep(`Inserted-${idx}`);
      const result = insertBetween(clonedMission, parentStep, childStep, mid);
      expect(result).withContext(`insertBetween failed for connection ${idx}`).toBeTrue();
    });
  });

  it('converts existing child into parallel lane when attaching another child', () => {
    const step4 = createStep('N4');
    const step2 = createStep('N2');
    const step1 = createStep('N1');

    const mission: Mission = {
      name: 'mission',
      is_setup: false,
      is_shutdown: false,
      order: 0,
      steps: [step1],
      comments: [],
    };

    attachChildSequentially(mission, step1, step2);
    attachChildSequentially(mission, step2, step4);

    const flow = createTestFlow({ mission });
    rebuildFromMission(flow, mission);
    recomputeMergedView(flow);

    const n1Id = flow.lookups.stepToNodeId.get(step1)!;
    const n4Id = flow.lookups.stepToNodeId.get(step4)!;

    const adHocNode: FlowNode = {
      id: 'adhoc-3',
      text: 'N3',
      position: { x: 200, y: 50 },
      step: { name: 'N3', arguments: [] },
      args: {},
    };

    flow.adHocNodes.set([...flow.adHocNodes(), adHocNode]);
    recomputeMergedView(flow);

    const event = new FCreateConnectionEvent(
      `${n1Id}-output`,
      `${adHocNode.id}-input`,
      { x: 0, y: 0 }
    );

    handleAddConnection(flow, event);

    const updatedMission = flow.missionState.currentMission()!;
    const seqStep = updatedMission.steps[0].children?.[0];
    expect(seqStep?.step_type).toBe('seq');

    const parallelStep = seqStep?.children?.[0];
    expect(parallelStep?.step_type).toBe('parallel');
    const parallelChildren = parallelStep?.children ?? [];
    expect(parallelChildren.length).toBe(2);

    const promotedStep = parallelChildren.find(ch => flow.lookups.stepToNodeId.get(ch) === adHocNode.id);
    expect(promotedStep?.function_name).toBe('N3');

    const tailStep = seqStep?.children?.[1];
    expect(tailStep?.function_name).toBe('N4');

    const currentConnections = flow.connections();
    const n3ToN4 = currentConnections.find(
      conn => baseId(conn.outputId, 'output') === adHocNode.id &&
        baseId(conn.inputId, 'input') === n4Id
    );
    expect(n3ToN4).toBeTruthy();
  });
});
