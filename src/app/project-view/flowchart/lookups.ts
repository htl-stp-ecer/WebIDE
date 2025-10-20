import { MissionStep } from '../../entities/MissionStep';

export class FlowchartLookupState {
  readonly stepToNodeId = new Map<MissionStep, string>();
  readonly nodeIdToStep = new Map<string, MissionStep>();
  readonly pathToNodeId = new Map<string, string>();
  readonly pathToConnectionIds = new Map<string, string[]>();
  readonly stepPaths = new Map<MissionStep, number[]>();
  readonly lastNodeHeights = new Map<string, number>();

  resetForMission(): void {
    this.stepToNodeId.clear();
    this.nodeIdToStep.clear();
    this.pathToNodeId.clear();
    this.pathToConnectionIds.clear();
    this.stepPaths.clear();
  }

  updateHeightsSnapshot(source: Map<string, number>): void {
    this.lastNodeHeights.clear();
    source.forEach((value, key) => this.lastNodeHeights.set(key, value));
  }

  setNodeLookups(stepToNode: Map<MissionStep, string>, nodeToStep: Map<string, MissionStep>): void {
    this.stepToNodeId.clear();
    this.nodeIdToStep.clear();
    stepToNode.forEach((value, key) => this.stepToNodeId.set(key, value));
    nodeToStep.forEach((value, key) => this.nodeIdToStep.set(key, value));
  }

  setPathLookups(nodePaths: Map<string, string>, connectionPaths: Map<string, string[]>): void {
    this.pathToNodeId.clear();
    this.pathToConnectionIds.clear();
    nodePaths.forEach((value, key) => this.pathToNodeId.set(key, value));
    connectionPaths.forEach((value, key) => this.pathToConnectionIds.set(key, value));
  }
}
