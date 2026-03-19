export type StepIdSource = {
  step_type?: unknown;
  function_name?: unknown;
  tags?: unknown;
};

export type StepTagCatalogEntry = {
  name?: unknown;
  tags?: unknown;
};

// Canonical built-in step ids. Values align with backend step catalog names.
export enum FlowStepId {
  Parallel = 'parallel',
  Seq = 'seq',
  Breakpoint = 'breakpoint',
  DriveForward = 'drive_forward',
  DriveBackward = 'drive_backward',
  TurnCw = 'turn_cw',
  TurnCcw = 'turn_ccw',
  TankTurnCw = 'tank_turn_cw',
  TankTurnCcw = 'tank_turn_ccw',
  StrafeLeft = 'strafe_left',
  StrafeRight = 'strafe_right',
  FollowLine = 'follow_line',
  DriveUntilBlack = 'drive_until_black',
  DriveUntilWhite = 'drive_until_white',
  ForwardLineupOnBlack = 'forward_lineup_on_black',
  ForwardLineupOnWhite = 'forward_lineup_on_white',
  BackwardLineupOnBlack = 'backward_lineup_on_black',
  BackwardLineupOnWhite = 'backward_lineup_on_white',
}

const TAG_MOTION = 'motion';
const TAG_DRIVE = 'drive';
const TAG_TURN = 'turn';
const TAG_STRAFE = 'strafe';
const TAG_LINEUP = 'lineup';
const TAG_SENSOR = 'sensor';
const LINE_FOLLOW_TAGS = new Set<string>(['line-follow', 'line_follow', 'linefollow']);

const TURN_STEP_IDS = new Set<string>([
  FlowStepId.TurnCw,
  FlowStepId.TurnCcw,
  FlowStepId.TankTurnCw,
  FlowStepId.TankTurnCcw,
]);

const DRIVE_STEP_IDS = new Set<string>([
  FlowStepId.DriveForward,
  FlowStepId.DriveBackward,
]);

const STRAFE_STEP_IDS = new Set<string>([
  FlowStepId.StrafeLeft,
  FlowStepId.StrafeRight,
]);

const LINEUP_STEP_IDS = new Set<string>([
  FlowStepId.ForwardLineupOnBlack,
  FlowStepId.ForwardLineupOnWhite,
  FlowStepId.BackwardLineupOnBlack,
  FlowStepId.BackwardLineupOnWhite,
]);

const STEP_TAGS_BY_ID = new Map<string, Set<string>>();

export type LineupDirection = 'forward' | 'backward';
export type LineupColor = 'black' | 'white';

const normalizeStepId = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim().toLowerCase();
  return String(value).trim().toLowerCase();
};

const normalizeTag = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
};

const normalizeTagSet = (tags: unknown): Set<string> => {
  if (!Array.isArray(tags)) return new Set<string>();
  const normalized = tags.map(normalizeTag).filter(tag => tag !== '');
  return new Set<string>(normalized);
};

export const configureStepTagCatalog = (steps: StepTagCatalogEntry[] | null | undefined): void => {
  STEP_TAGS_BY_ID.clear();
  if (!Array.isArray(steps)) return;

  for (const step of steps) {
    const id = normalizeStepId(step?.name);
    if (!id) continue;
    const tags = normalizeTagSet(step?.tags);
    if (!tags.size) continue;
    STEP_TAGS_BY_ID.set(id, tags);
  }
};

const idTags = (id: string): Set<string> => STEP_TAGS_BY_ID.get(id) ?? new Set<string>();

const sourceTags = (step: StepIdSource | null | undefined): Set<string> => {
  const tags = normalizeTagSet(step?.tags);
  if (tags.size) return tags;

  const resolved = new Set<string>();
  const fn = normalizeStepId(step?.function_name);
  const st = normalizeStepId(step?.step_type);
  const fnTags = idTags(fn);
  const stTags = idTags(st);
  for (const tag of fnTags) resolved.add(tag);
  for (const tag of stTags) resolved.add(tag);
  return resolved;
};

const hasAnyTag = (tags: Set<string>, candidates: string[]): boolean =>
  candidates.some(candidate => tags.has(normalizeTag(candidate)));

const idHasAnyTag = (id: string, candidates: string[]): boolean => hasAnyTag(idTags(id), candidates);

export const stepId = (step?: StepIdSource | null): string => {
  const functionName = step?.function_name;
  if (typeof functionName === 'string' && functionName.trim() !== '') {
    return normalizeStepId(functionName);
  }
  const stepType = step?.step_type;
  if (typeof stepType === 'string' && stepType.trim() !== '') {
    return normalizeStepId(stepType);
  }
  return normalizeStepId(functionName ?? stepType);
};

export const stepIdIncludes = (step: StepIdSource | null | undefined, token: string): boolean =>
  stepId(step).includes(token.toLowerCase());

export const stepIdIn = (step: StepIdSource | null | undefined, ids: string[]): boolean => {
  const id = stepId(step);
  return ids.some(entry => entry.toLowerCase() === id);
};

export const isStepId = (id: string, expected: FlowStepId): boolean => id === expected;

export const isBackwardStepId = (id: string): boolean => id.includes('backward') || id.includes('reverse');
export const isForwardStepId = (id: string): boolean => id.includes('forward');
export const isCounterClockwiseStepId = (id: string): boolean => id.includes('_ccw') || id.endsWith('ccw') || id.includes('left');
export const isClockwiseStepId = (id: string): boolean =>
  (id.includes('_cw') || id.endsWith('cw') || id.includes('right')) && !isCounterClockwiseStepId(id);
export const isLeftStepId = (id: string): boolean => id.includes('left');
export const isRightStepId = (id: string): boolean => id.includes('right');

export const isLineupStepId = (id: string): boolean => {
  if (LINEUP_STEP_IDS.has(id)) return true;
  if (idHasAnyTag(id, [TAG_LINEUP])) return true;
  return id.includes('lineup');
};

export const isFollowLineStepId = (id: string): boolean => {
  if (id === FlowStepId.FollowLine) return true;
  if (idHasAnyTag(id, Array.from(LINE_FOLLOW_TAGS))) return true;
  return id.includes('follow_line') || id.includes('line_follow');
};

export const isDriveStepId = (id: string): boolean => {
  if (DRIVE_STEP_IDS.has(id)) return true;
  const tags = idTags(id);
  if (tags.has(TAG_DRIVE) && !tags.has(TAG_SENSOR)) return true;
  return (id.includes('drive') || id.startsWith('go_')) && !id.includes('until');
};

export const isTurnStepId = (id: string): boolean => {
  if (TURN_STEP_IDS.has(id)) return true;
  if (idHasAnyTag(id, [TAG_TURN])) return true;
  return id.includes('turn');
};

export const isStrafeStepId = (id: string): boolean => {
  if (STRAFE_STEP_IDS.has(id)) return true;
  if (idHasAnyTag(id, [TAG_STRAFE])) return true;
  return id.includes('strafe');
};

export const isDriveOrStrafeStepId = (id: string): boolean => isDriveStepId(id) || isStrafeStepId(id);

export const driveUntilColorFromStepId = (id: string): 'black' | 'white' | null => {
  if (id === FlowStepId.DriveUntilBlack) return 'black';
  if (id === FlowStepId.DriveUntilWhite) return 'white';

  const tags = idTags(id);
  const isDriveSensor = (tags.has(TAG_DRIVE) || id.includes('drive')) && (tags.has(TAG_SENSOR) || id.includes('until'));
  if (!isDriveSensor) return null;
  if (id.includes('black')) return 'black';
  if (id.includes('white')) return 'white';
  return null;
};

export const lineupDirectionFromStepId = (id: string): LineupDirection | null => {
  if (!isLineupStepId(id)) return null;
  if (isForwardStepId(id)) return 'forward';
  if (isBackwardStepId(id)) return 'backward';
  return null;
};

export const lineupColorFromStepId = (id: string): LineupColor | null => {
  if (!isLineupStepId(id)) return null;
  if (id.includes('black')) return 'black';
  if (id.includes('white')) return 'white';
  return null;
};

export const isLineupStep = (step: StepIdSource | null | undefined): boolean => {
  const id = stepId(step);
  if (isLineupStepId(id)) return true;
  return hasAnyTag(sourceTags(step), [TAG_LINEUP]);
};

export const isFollowLineStep = (step: StepIdSource | null | undefined): boolean => {
  const id = stepId(step);
  if (isFollowLineStepId(id)) return true;
  return hasAnyTag(sourceTags(step), Array.from(LINE_FOLLOW_TAGS));
};

export const isDriveStep = (step: StepIdSource | null | undefined): boolean => {
  const id = stepId(step);
  if (isDriveStepId(id)) return true;
  const tags = sourceTags(step);
  return tags.has(TAG_DRIVE) && !tags.has(TAG_SENSOR);
};

export const isTurnStep = (step: StepIdSource | null | undefined): boolean => {
  const id = stepId(step);
  if (isTurnStepId(id)) return true;
  return hasAnyTag(sourceTags(step), [TAG_TURN]);
};

export const isStrafeStep = (step: StepIdSource | null | undefined): boolean => {
  const id = stepId(step);
  if (isStrafeStepId(id)) return true;
  return hasAnyTag(sourceTags(step), [TAG_STRAFE]);
};

export const isMotionStep = (step: StepIdSource | null | undefined): boolean => {
  const tags = sourceTags(step);
  if (tags.has(TAG_MOTION)) return true;
  const id = stepId(step);
  return isDriveOrStrafeStepId(id) || isTurnStepId(id) || isLineupStepId(id) || isFollowLineStepId(id);
};

export const lineupStepId = (direction: LineupDirection, color: LineupColor): FlowStepId => {
  if (direction === 'forward' && color === 'black') return FlowStepId.ForwardLineupOnBlack;
  if (direction === 'forward' && color === 'white') return FlowStepId.ForwardLineupOnWhite;
  if (direction === 'backward' && color === 'black') return FlowStepId.BackwardLineupOnBlack;
  return FlowStepId.BackwardLineupOnWhite;
};
