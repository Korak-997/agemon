import { mulberry32, pickFrom } from "./random.js";
import type { RoutingRun } from "./run.js";

export interface CostDifference {
  meanDifference: number;
  low: number;
  high: number;
}

const LOWER_QUANTILE = 0.025;
const UPPER_QUANTILE = 0.975;

export function costPerSolvedTask(runs: readonly RoutingRun[]): number {
  const solved = runs.filter((run) => run.passed).length;
  if (solved === 0) return Number.POSITIVE_INFINITY;
  return runs.reduce((sum, run) => sum + run.costUsd, 0) / solved;
}

function runsByTask(runs: readonly RoutingRun[]): RoutingRun[][] {
  const grouped = new Map<string, RoutingRun[]>();
  for (const run of runs) {
    grouped.set(run.task, [...(grouped.get(run.task) ?? []), run]);
  }
  return [...grouped.values()];
}
function differenceOrNoSaving(candidate: number, baseline: number): number {
  const difference = candidate - baseline;
  return Number.isNaN(difference) ? Number.POSITIVE_INFINITY : difference;
}

export function bootstrapDifference(
  baseline: readonly RoutingRun[],
  candidate: readonly RoutingRun[],
  resamples: number,
  seed: number,
): CostDifference {
  const random = mulberry32(seed);
  const resampleWithinTasks = (taskRuns: RoutingRun[][]) =>
    taskRuns.flatMap((runs) => runs.map(() => pickFrom(random, runs)));
  const baselineTasks = runsByTask(baseline);
  const candidateTasks = runsByTask(candidate);
  const differences = Float64Array.from({ length: resamples }, () => {
    const resampledBaseline = costPerSolvedTask(
      resampleWithinTasks(baselineTasks),
    );
    return differenceOrNoSaving(
      costPerSolvedTask(resampleWithinTasks(candidateTasks)),
      resampledBaseline,
    );
  }).sort();
  return {
    meanDifference: differenceOrNoSaving(
      costPerSolvedTask(candidate),
      costPerSolvedTask(baseline),
    ),
    low: differences[Math.floor(LOWER_QUANTILE * resamples)],
    high: differences[Math.ceil(UPPER_QUANTILE * resamples) - 1],
  };
}
