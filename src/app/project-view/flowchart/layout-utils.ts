import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { FlowNode, FlowOrientation } from './models';
import { isType } from './models';

export function computeAutoLayout(
  mission: Mission | null | undefined,
  nodes: FlowNode[],
  stepToNodeId: Map<MissionStep, string>,
  heights: Map<string, number>,
  startNodeId: string,
  orientation: FlowOrientation = 'vertical',
  laneWidth = 275,
  vGap = 75,
  hGap = 110
): FlowNode[] {
  if (!mission) return nodes;
  const newNodes = nodes.map(n => ({ ...n, position: { ...n.position } }));

  const setPos = (id: string, p: { x: number; y: number }) => {
    const idx = newNodes.findIndex(n => n.id === id);
    if (idx > -1) newNodes[idx] = { ...newNodes[idx], position: p };
  };

  const hStart = heights.get(startNodeId) ?? 80;
  const rootGap = orientation === 'vertical' ? 100 : hGap;
  let y = hStart + rootGap;

  const effectiveGap = orientation === 'vertical' ? vGap : hGap;

  const layout = (steps: MissionStep[], start: { x: number; y: number }, w = laneWidth, gap = effectiveGap): { maxY: number } => {
    if (!steps.length) return { maxY: start.y };
    const nodeH = (s: MissionStep) => {
      if (orientation !== 'vertical') {
        return 0;
      }
      return (isType(s, 'parallel') || isType(s, 'seq')) ? 0 : heights.get(stepToNodeId.get(s) ?? '') ?? 80;
    };
    const hs = steps.map(nodeH);
    const maxH = orientation === 'vertical' ? Math.max(0, ...hs) : 0;
    const totalW = (steps.length - 1) * w;
    const x0 = start.x - totalW / 2;
    let maxY = start.y;

    steps.forEach((s, i) => {
      const x = x0 + i * w;
      if (isType(s, 'seq')) {
        let yCur = start.y, local = start.y;
        for (const ch of (s.children ?? [])) {
          const r = layout([ch], { x, y: yCur }, w, gap);
          yCur = r.maxY + gap;
          local = Math.max(local, r.maxY);
        }
        maxY = Math.max(maxY, local);
        return;
      }
      if (isType(s, 'parallel')) {
        if (s.children?.length) maxY = Math.max(maxY, layout(s.children, { x, y: start.y }, w, gap).maxY);
        return;
      }
      const id = stepToNodeId.get(s);
      if (id) setPos(id, { x, y: start.y });
      const span = orientation === 'vertical' ? Math.max(hs[i] || 0, maxH) : 0;
      const belowY = start.y + span + gap;
      maxY = Math.max(maxY, s.children?.length ? layout(s.children, { x, y: belowY }, w, gap).maxY : start.y + (hs[i] || 0));
    });
    return { maxY };
  };

  for (const s of mission.steps) {
    y = layout([s], { x: 300, y }).maxY + rootGap;
  }

  if (orientation === 'horizontal') {
    const missionNodeIds = new Set<string>(stepToNodeId.values());
    return newNodes.map(node => {
      if (!missionNodeIds.has(node.id)) {
        return node;
      }
      const height = heights.get(node.id) ?? 80;
      return {
        ...node,
        position: {
          x: node.position.y,
          y: node.position.x - height / 2,
        },
      };
    });
  }

  return newNodes;
}
