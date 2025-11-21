import { signal } from '@angular/core';
import { FCreateConnectionEvent, FNodeIntersectedWithConnections } from '@foblex/flow';
import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { FlowNode, Connection, Step, baseId, isType } from './models';
import { Flowchart } from './flowchart';
import { FlowchartLookupState } from './lookups';
import { handleAddConnection, handleNodeIntersected } from './connection-handlers';
import { recomputeMergedView } from './view-merger';
import { rebuildFromMission } from './mission-handlers';
import { insertBetween, attachChildSequentially, shouldAppendSequentially } from './mission-sequence-utils';
import { attachChildWithParallel } from './mission-parallel-utils';

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
      expect(missionSteps.length).toBe(3);
      expect(missionSteps[0]).toBe(stepA);

      const insertedStep = missionSteps[1];
      expect(insertedStep?.function_name).toBe('X');
      expect(insertedStep.children?.length ?? 0).toBe(0);
      expect(missionSteps[2]).toBe(stepB);
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

      const updatedSteps = mission.steps;
      expect(updatedSteps.length).toBe(4);
      expect(updatedSteps[0]).toBe(stepA);
      expect(updatedSteps[1]).toBe(insertedStep);
      const nestedInsertedStep = updatedSteps[2];
      expect(nestedInsertedStep?.function_name).toBe('Y');
      expect(nestedInsertedStep?.children?.length ?? 0).toBe(0);
      expect(updatedSteps[3]).toBe(stepB);
    });

    it('inserts node into parallel lane sequence when splitting lane exit', () => {
      const laneOne = createStep('Lane-1');
      const laneTwo = createStep('Lane-2');
      const laneSeq = createStep('Lane-Seq', [], [laneOne, laneTwo], 'seq');
      const otherLane = createStep('Other-Lane');
      const parallel = createStep('Parallel', [], [laneSeq, otherLane], 'parallel');
      const tail = createStep('Tail');

      const mission: Mission = {
        name: 'mission',
        is_setup: false,
        is_shutdown: false,
        order: 0,
        steps: [parallel, tail],
        comments: [],
      };

      const flow = createTestFlow({ mission });

      rebuildFromMission(flow, mission);
      recomputeMergedView(flow);

      const adHocNode: FlowNode = {
        id: 'adhoc-parallel',
        text: 'Insert',
        position: { x: 0, y: 0 },
        step: { name: 'Insert', arguments: [] },
        args: {},
      };

      flow.adHocNodes.set([...flow.adHocNodes(), adHocNode]);
      recomputeMergedView(flow);

      const laneTwoNodeId = flow.lookups.stepToNodeId.get(laneTwo)!;
      const tailNodeId = flow.lookups.stepToNodeId.get(tail)!;
      const targetConnection = flow.connections().find(
        c => c.sourceNodeId === laneTwoNodeId && c.targetNodeId === tailNodeId
      );
      expect(targetConnection).toBeTruthy();

      const event = new FNodeIntersectedWithConnections(adHocNode.id, [targetConnection!.id]);

      handleNodeIntersected(flow, event);

      const laneChildren = laneSeq.children ?? [];
      expect(laneChildren.length).toBe(3);
      expect(laneChildren[0]).toBe(laneOne);
      expect(laneChildren[1]).toBe(laneTwo);

      const insertedStep = laneChildren[2];
      expect(insertedStep?.function_name).toBe('Insert');
      expect(insertedStep?.children?.length ?? 0).toBe(0);
      expect(mission.steps?.[1]).toBe(tail);
      expect(flow.historyManager.recordHistory).toHaveBeenCalledWith('split-mission-connection');
  });

  it('keeps downstream node outside parallel when splitting lane wrapped in seq', () => {
    const laneStep = createStep('Lane');
    const laneSeq = createStep('Lane-Seq', [], [laneStep], 'seq');
    const otherLane = createStep('Other-Lane');
    const parallel = createStep('Parallel', [], [laneSeq, otherLane], 'parallel');
    const tail = createStep('Tail');
    const rootSeq = createStep('Root-Seq', [], [parallel, tail], 'seq');

    const mission: Mission = {
      name: 'mission',
      is_setup: false,
      is_shutdown: false,
      order: 0,
      steps: [rootSeq],
      comments: [],
    };

    const flow = createTestFlow({ mission });
    rebuildFromMission(flow, mission);
    recomputeMergedView(flow);

    const adHocNode: FlowNode = {
      id: 'adhoc-lane',
      text: 'InsertLane',
      position: { x: 0, y: 0 },
      step: { name: 'InsertLane', arguments: [] },
      args: {},
    };

    flow.adHocNodes.set([...flow.adHocNodes(), adHocNode]);
    recomputeMergedView(flow);

    const laneNodeId = flow.lookups.stepToNodeId.get(laneStep)!;
    const tailNodeId = flow.lookups.stepToNodeId.get(tail)!;
    const targetConnection = flow.connections().find(
      c => c.sourceNodeId === laneNodeId && c.targetNodeId === tailNodeId
    );
    expect(targetConnection).toBeTruthy();

    const event = new FNodeIntersectedWithConnections(adHocNode.id, [targetConnection!.id]);
    handleNodeIntersected(flow, event);

    const laneChildren = laneSeq.children ?? [];
    expect(laneChildren.length).toBe(2);
    expect(laneChildren[0]).toBe(laneStep);
    const insertedLaneStep = laneChildren[1];
    expect(insertedLaneStep?.function_name).toBe('InsertLane');

    const rootSeqChildren = rootSeq.children ?? [];
    expect(rootSeqChildren.length).toBe(2);
    expect(rootSeqChildren[0]).toBe(parallel);
    expect(rootSeqChildren[1]).toBe(tail);
  });
});

it('keeps downstream node outside parallel when adding new parallel child', () => {
    const tail = createStep('N4');
    const laneA = createStep('N2');
    const laneB = createStep('N3');
    const parallel = createStep('parallel', [], [laneA, laneB], 'parallel');
    const seq = createStep('seq', [], [parallel, tail], 'seq');
    const parent = createStep('Parent', [], [seq]);

    const mission: Mission = {
      name: 'mission',
      is_setup: false,
      is_shutdown: false,
      order: 0,
      steps: [parent],
      comments: [],
    };

    const newLane = createStep('N5');

    const result = attachChildWithParallel(mission, parallel, newLane);
    expect(result).toBeTrue();

    const parallelChildren = parallel.children ?? [];
    expect(parallelChildren.some(ch => ch === laneA)).toBeTrue();
    expect(parallelChildren.some(ch => ch === laneB)).toBeTrue();
    expect(parallelChildren.some(ch => ch === newLane)).toBeTrue();

    const seqChildren = seq.children ?? [];
    expect(seqChildren.length).toBe(2);
    expect(seqChildren[1]).toBe(tail);
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
    console.log('step1 children after', step1.children);

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

  it('appends a new top-level step when connecting from the tail node', () => {
    const step1 = createStep('First');
    const step2 = createStep('Second');
    const mission: Mission = {
      name: 'mission',
      is_setup: false,
      is_shutdown: false,
      order: 0,
      steps: [step1, step2],
      comments: [],
    };

    const flow = createTestFlow({ mission });
    rebuildFromMission(flow, mission);
    recomputeMergedView(flow);

    const adHocNode: FlowNode = {
      id: 'adhoc-tail',
      text: 'Third',
      position: { x: 180, y: 120 },
      step: { name: 'Third', arguments: [] },
      args: {},
    };

    flow.adHocNodes.set([...flow.adHocNodes(), adHocNode]);
    recomputeMergedView(flow);

    const step2NodeId = flow.lookups.stepToNodeId.get(step2)!;
    const event = new FCreateConnectionEvent(
      `${step2NodeId}-output`,
      `${adHocNode.id}-input`,
      { x: 0, y: 0 }
    );

    handleAddConnection(flow, event);

    expect(mission.steps.length).toBe(3);
    expect(mission.steps[0]).toBe(step1);
    expect(mission.steps[1]).toBe(step2);
    const appendedStep = mission.steps[2];
    expect(appendedStep?.function_name).toBe('Third');
    expect(step2.children?.length ?? 0).toBe(0);
  });

  it('does not treat the last top-level step as sequential append candidate', () => {
    const step1 = createStep('First');
    const step2 = createStep('Second');
    const mission: Mission = {
      name: 'mission',
      is_setup: false,
      is_shutdown: false,
      order: 0,
      steps: [step1, step2],
      comments: [],
    };

    expect(shouldAppendSequentially(mission, step2)).toBeFalse();
  });

  it('appends sequentially inside a parallel lane without moving downstream steps', () => {
    const laneStep = createStep('Lane');
    const laneSeq = createStep('seq', [], [laneStep], 'seq');
    const otherLane = createStep('OtherLane');
    const parallel = createStep('parallel', [], [laneSeq, otherLane], 'parallel');
    const tail = createStep('Tail');

    const mission: Mission = {
      name: 'mission',
      is_setup: false,
      is_shutdown: false,
      order: 0,
      steps: [parallel, tail],
      comments: [],
    };

    const newStep = createStep('Inserted');
    const attached = attachChildSequentially(mission, laneStep, newStep);
    expect(attached).toBeTrue();

    const seqChildren = laneSeq.children ?? [];
    expect(seqChildren.length).toBe(2);
    expect(seqChildren[0]).toBe(laneStep);
    expect(seqChildren[1]).toBe(newStep);

    const parallelChildren = parallel.children ?? [];
    expect(parallelChildren.length).toBe(2);
    expect(parallelChildren[1]).toBe(otherLane);

    expect(mission.steps?.[1]).toBe(tail);
  });

  it('appends to the mission list when parallel attachment targets the final top-level step', () => {
    const tail = createStep('Tail');
    const mission: Mission = {
      name: 'mission',
      is_setup: false,
      is_shutdown: false,
      order: 0,
      steps: [tail],
      comments: [],
    };

    const inserted = createStep('Inserted');
    const result = attachChildWithParallel(mission, tail, inserted);
    expect(result).toBeTrue();
    expect(mission.steps.length).toBe(2);
    expect(mission.steps[1]).toBe(inserted);
    expect(tail.children?.length ?? 0).toBe(0);
  });

  it('inserting between a parallel lane and downstream node keeps tail outside parallel', () => {
    const tail = createStep('N4');
    const laneA = createStep('N2');
    const laneB = createStep('N3');
    const parallel = createStep('parallel', [], [laneA, laneB], 'parallel');
    const seq = createStep('seq', [], [parallel, tail], 'seq');
    const parent = createStep('Parent', [], [seq]);

    const mission: Mission = {
      name: 'mission',
      is_setup: false,
      is_shutdown: false,
      order: 0,
      steps: [parent],
      comments: [],
    };

    const mid = createStep('NewNode');
    const inserted = insertBetween(mission, laneA, tail, mid);
    expect(inserted).toBeTrue();

    const seqChildren = seq.children ?? [];
    expect(seqChildren.length).toBe(2);
    expect(seqChildren[0]).toBe(parallel);
    expect(seqChildren[1]).toBe(tail);

    const parallelChildren = parallel.children ?? [];
    expect(parallelChildren.length).toBe(2);
    const wrappedLane = parallelChildren.find(ch => isType(ch, 'seq'));
    expect(wrappedLane).toBeTruthy();
    expect(wrappedLane?.children?.[0]).toBe(laneA);
    expect(wrappedLane?.children?.[1]).toBe(mid);

    const untouchedLane = parallelChildren.find(ch => ch === laneB || (ch.children?.includes(laneB)));
    expect(untouchedLane).toBe(laneB);
  });

  it('treats trailing structural siblings as empty when checking sequential append eligibility', () => {
    const tail = createStep('Tail');
    const emptySeq = createStep('SeqWrapper', [], [], 'seq');
    const emptyParallel = createStep('ParallelWrapper', [], [], 'parallel');
    const breakPoint = createStep('BreakpointWrapper', [], [], 'breakpoint');
    emptyParallel.children = [createStep('NestedSeq', [], [], 'seq')];
    breakPoint.children = [createStep('NestedParallel', [], [], 'parallel')];

    const mission: Mission = {
      name: 'mission',
      is_setup: false,
      is_shutdown: false,
      order: 0,
      steps: [tail, emptySeq, emptyParallel, breakPoint],
      comments: [],
    };

    expect(shouldAppendSequentially(mission, tail)).toBeTrue();
  });
});
