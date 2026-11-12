export type SkillRoutingArm = "N";

export interface SkillRoutingCase {
  id: string;
  prompt: string;
  expected: string[];
}

export type RoutingOutcome =
  | "hit"
  | "wrong-skill"
  | "miss"
  | "false-trigger"
  | "quiet";

export interface SkillRoutingRun {
  caseId: string;
  arm: SkillRoutingArm;
  outcome: RoutingOutcome;
  invoked: string[];
  foreign: string[];
  skillCalls: number;
  announcedSkillCount: number;
  errored: boolean;
  errorReason?: string;
  costUsd?: number;
  numTurns?: number;
  transcriptPath?: string;
}

export interface SkillRoutingSummary {
  runs: number;
  recall: number | null;
  wrongSkillRate: number | null;
  falseTriggerRate: number | null;
  foreignInvocations: number;
  skillCalls: number;
  meanCostUsd: number | null;
}

const POSITIVE_OUTCOMES: ReadonlySet<RoutingOutcome> = new Set([
  "hit",
  "wrong-skill",
  "miss",
]);

function isForeign(skillName: string): boolean {
  return skillName.includes(":");
}

export function classifyInvocations(
  invoked: readonly string[],
  expected: readonly string[],
  evaluated: ReadonlySet<string>,
): { outcome: RoutingOutcome; foreign: string[] } {
  const foreign = invoked.filter(isForeign);
  const projectInvoked = invoked.filter((name) => !isForeign(name));
  if (expected.length === 0) {
    return {
      outcome: projectInvoked.length > 0 ? "false-trigger" : "quiet",
      foreign,
    };
  }
  if (projectInvoked.some((name) => expected.includes(name))) {
    return { outcome: "hit", foreign };
  }
  if (projectInvoked.some((name) => evaluated.has(name))) {
    return { outcome: "wrong-skill", foreign };
  }
  return { outcome: "miss", foreign };
}

function ratio(count: number, total: number): number | null {
  return total === 0 ? null : count / total;
}

export function summarizeSkillRouting(
  runs: readonly SkillRoutingRun[],
): SkillRoutingSummary {
  const scored = runs.filter((run) => !run.errored);
  const positives = scored.filter((run) => POSITIVE_OUTCOMES.has(run.outcome));
  const negatives = scored.filter((run) => !POSITIVE_OUTCOMES.has(run.outcome));
  const countOf = (outcome: RoutingOutcome) =>
    scored.filter((run) => run.outcome === outcome).length;
  const costs = runs.flatMap((run) =>
    run.costUsd === undefined ? [] : [run.costUsd],
  );
  return {
    runs: runs.length,
    recall: ratio(countOf("hit"), positives.length),
    wrongSkillRate: ratio(countOf("wrong-skill"), positives.length),
    falseTriggerRate: ratio(countOf("false-trigger"), negatives.length),
    foreignInvocations: runs.reduce((sum, run) => sum + run.foreign.length, 0),
    skillCalls: runs.reduce((sum, run) => sum + run.skillCalls, 0),
    meanCostUsd: ratio(
      costs.reduce((sum, cost) => sum + cost, 0),
      costs.length,
    ),
  };
}

export function assertSkillToolWasUsed(runs: readonly SkillRoutingRun[]): void {
  if (runs.every((run) => run.skillCalls === 0)) {
    throw new Error(`no Skill call in ${runs.length} runs`);
  }
}
