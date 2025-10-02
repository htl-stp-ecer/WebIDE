import { Mission } from '../../entities/Mission';
import { MissionStep } from '../../entities/MissionStep';
import { FlowNode } from './models';
import { isType } from './models';

export function computeAutoLayout(
  mission: Mission | null | undefined,
  nodes: FlowNode[],
  stepToNodeId: Map<MissionStep, string>,
  heights: Map<string, number>,
  startNodeId: string,
  laneWidth = 275,
  vGap = 75
): FlowNode[] {
  if (!mission) return nodes;
  const newNodes = nodes.map(n => ({ ...n, position: { ...n.position } }));

  const setPos = (id: string, p: { x: number; y: number }) => {
    const idx = newNodes.findIndex(n => n.id === id);
    if (idx > -1) newNodes[idx] = { ...newNodes[idx], position: p };
  };

  const hStart = heights.get(startNodeId) ?? 80;
  let y = hStart + 100;

  const layout = (steps: MissionStep[], start: { x: number; y: number }, w = laneWidth, gap = vGap): { maxY: number } => {
    if (!steps.length) return { maxY: start.y };
    const nodeH = (s: MissionStep) => (isType(s, 'parallel') || isType(s, 'seq') ? 0 : heights.get(stepToNodeId.get(s) ?? '') ?? 80);
    const hs = steps.map(nodeH), maxH = Math.max(0, ...hs), totalW = (steps.length - 1) * w, x0 = start.x - totalW / 2;
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
      const belowY = start.y + Math.max(hs[i] || 0, maxH) + gap;
      maxY = Math.max(maxY, s.children?.length ? layout(s.children, { x, y: belowY }, w, gap).maxY : start.y + (hs[i] || 0));
    });
    return { maxY };
  };

  for (const s of mission.steps) {
    y = layout([s], { x: 300, y }).maxY + 100;
  }
  return newNodes;
}

