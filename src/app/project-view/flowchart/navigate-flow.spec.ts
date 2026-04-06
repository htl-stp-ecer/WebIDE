import { describe, it, expect } from 'vitest';
import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { FlowNode, Connection, baseId } from './models';
import { rebuildMissionView } from './mission-builder';
import { START_OUTPUT_ID } from './constants';

const createStep = (name: string, children: MissionStep[] = []): MissionStep => ({
  step_type: name,
  function_name: name,
  arguments: [],
  position: { x: 0, y: 0 },
  children,
});

const mkSeq = (...children: MissionStep[]): MissionStep => ({
  step_type: 'seq',
  function_name: 'seq',
  arguments: [],
  position: { x: 0, y: 0 },
  children,
});

const mkParallel = (...children: MissionStep[]): MissionStep => ({
  step_type: 'parallel',
  function_name: 'parallel',
  arguments: [],
  position: { x: 0, y: 0 },
  children,
});

const asStep = (ms: MissionStep) => ({ name: ms.function_name, arguments: [] });
const initialArgs = () => ({});

/** Build nav graph helpers from a mission — mirrors the component's buildNavGraph() */
function buildNavGraph(allNodes: FlowNode[], connections: Connection[]) {
  const realNodes = allNodes.filter(
    n => n.step?.name !== '__junction__' && n.id !== 'start-node' && n.id !== 'end-node'
  );
  const nodeSet = new Set(realNodes.map(n => n.id));
  const junctionIds = new Set(
    allNodes.filter(n => n.step?.name === '__junction__').map(n => n.id)
  );

  const connSrc = (c: Connection) => c.sourceNodeId ?? baseId(c.outputId, 'output');
  const connTgt = (c: Connection) => c.targetNodeId ?? baseId(c.inputId, 'input');

  const outgoing = new Map<string, Connection[]>();
  const incoming = new Map<string, Connection[]>();
  for (const c of connections) {
    const src = connSrc(c);
    const tgt = connTgt(c);
    (outgoing.get(src) ?? (outgoing.set(src, []), outgoing.get(src)!)).push(c);
    (incoming.get(tgt) ?? (incoming.set(tgt, []), incoming.get(tgt)!)).push(c);
  }

  const resolveForward = (sourceId: string): string[] => {
    const targets: string[] = [];
    const seen = new Set<string>();
    const explore = (id: string) => {
      for (const c of outgoing.get(id) ?? []) {
        const tgt = connTgt(c);
        if (tgt === 'end-node' || nodeSet.has(tgt)) {
          targets.push(tgt);
        } else if (junctionIds.has(tgt) && !seen.has(tgt)) {
          seen.add(tgt);
          explore(tgt);
        }
      }
    };
    explore(sourceId);
    return targets;
  };

  const resolveBackward = (targetId: string): string[] => {
    const sources: string[] = [];
    const seen = new Set<string>();
    const explore = (id: string) => {
      for (const c of incoming.get(id) ?? []) {
        const src = connSrc(c);
        if (src === 'start-node' || nodeSet.has(src)) {
          sources.push(src);
        } else if (junctionIds.has(src) && !seen.has(src)) {
          seen.add(src);
          explore(src);
        }
      }
    };
    explore(targetId);
    return sources;
  };

  return { nodeSet, realNodes, resolveForward, resolveBackward };
}

function buildMission(steps: MissionStep[]) {
  const mission: Mission = {
    name: 'test', is_setup: false, is_shutdown: false, order: 0, steps,
  };
  return rebuildMissionView(mission, new Map(), asStep, initialArgs, START_OUTPUT_ID);
}

/** Resolve a step name to node id */
function nodeByName(nodes: FlowNode[], name: string) {
  return nodes.find(n => n.text === name)!;
}

describe('flowchart navigation graph', () => {
  describe('linear mission (A → B → C)', () => {
    const result = buildMission([createStep('A'), createStep('B'), createStep('C')]);
    const nav = buildNavGraph(result.nodes, result.connections);
    const A = nodeByName(result.nodes, 'A');
    const B = nodeByName(result.nodes, 'B');
    const C = nodeByName(result.nodes, 'C');

    it('forward from start reaches A', () => {
      const targets = nav.resolveForward('start-node');
      expect(targets).toContain(A.id);
    });

    it('forward from A reaches B', () => {
      expect(nav.resolveForward(A.id)).toContain(B.id);
    });

    it('forward from B reaches C', () => {
      expect(nav.resolveForward(B.id)).toContain(C.id);
    });

    it('forward from C reaches end-node', () => {
      expect(nav.resolveForward(C.id)).toContain('end-node');
    });

    it('backward from C reaches B', () => {
      expect(nav.resolveBackward(C.id)).toContain(B.id);
    });

    it('backward from A reaches start-node', () => {
      expect(nav.resolveBackward(A.id)).toContain('start-node');
    });

    it('no siblings in a linear flow', () => {
      const parents = nav.resolveBackward(B.id);
      for (const p of parents) {
        const siblings = nav.resolveForward(p).filter(id => id !== 'end-node');
        expect(siblings.length).toBe(1);
      }
    });
  });

  describe('parallel mission: A → parallel(B, C) → D', () => {
    const result = buildMission([
      createStep('A'),
      mkParallel(createStep('B'), createStep('C')),
      createStep('D'),
    ]);
    const nav = buildNavGraph(result.nodes, result.connections);
    const A = nodeByName(result.nodes, 'A');
    const B = nodeByName(result.nodes, 'B');
    const C = nodeByName(result.nodes, 'C');
    const D = nodeByName(result.nodes, 'D');

    it('forward from A reaches both B and C (through fork junction)', () => {
      const targets = nav.resolveForward(A.id);
      expect(targets).toContain(B.id);
      expect(targets).toContain(C.id);
    });

    it('forward from B reaches D (through join junction)', () => {
      expect(nav.resolveForward(B.id)).toContain(D.id);
    });

    it('forward from C reaches D (through join junction)', () => {
      expect(nav.resolveForward(C.id)).toContain(D.id);
    });

    it('backward from B reaches A (through fork junction)', () => {
      expect(nav.resolveBackward(B.id)).toContain(A.id);
    });

    it('backward from D reaches both B and C (through join junction)', () => {
      const sources = nav.resolveBackward(D.id);
      expect(sources).toContain(B.id);
      expect(sources).toContain(C.id);
    });

    it('B and C are siblings — they share a parent (A)', () => {
      const parentsOfB = nav.resolveBackward(B.id);
      expect(parentsOfB).toContain(A.id);
      const siblingsFromA = nav.resolveForward(A.id).filter(id => id !== 'end-node');
      expect(siblingsFromA).toContain(B.id);
      expect(siblingsFromA).toContain(C.id);
      expect(siblingsFromA.length).toBe(2);
    });
  });

  describe('parallel with lanes: parallel(seq(L1A, L1B), seq(L2A, L2B))', () => {
    const result = buildMission([
      mkParallel(
        mkSeq(createStep('L1A'), createStep('L1B')),
        mkSeq(createStep('L2A'), createStep('L2B')),
      ),
    ]);
    const nav = buildNavGraph(result.nodes, result.connections);
    const L1A = nodeByName(result.nodes, 'L1A');
    const L1B = nodeByName(result.nodes, 'L1B');
    const L2A = nodeByName(result.nodes, 'L2A');

    it('forward from start reaches both lane heads (L1A and L2A)', () => {
      const targets = nav.resolveForward('start-node');
      expect(targets).toContain(L1A.id);
      expect(targets).toContain(L2A.id);
    });

    it('L1A and L2A are siblings', () => {
      const parents = nav.resolveBackward(L1A.id);
      for (const p of parents) {
        const siblings = nav.resolveForward(p).filter(id => id !== 'end-node' && nav.nodeSet.has(id));
        if (siblings.length > 1) {
          expect(siblings).toContain(L1A.id);
          expect(siblings).toContain(L2A.id);
        }
      }
    });

    it('forward within a lane: L1A → L1B', () => {
      expect(nav.resolveForward(L1A.id)).toContain(L1B.id);
    });
  });
});
