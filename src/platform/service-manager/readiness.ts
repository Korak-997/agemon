import { setTimeout as sleep } from "node:timers/promises";

export interface ServiceClock {
  now(): number;
  wait(milliseconds: number): Promise<void>;
}

export type ReadinessObservation =
  | { kind: "running" }
  | { kind: "pending"; state: string }
  | { kind: "failed"; reason: string };

const READINESS_POLL_INTERVAL_MS = 500;
const READINESS_TIMEOUT_MS = 10_000;
const READINESS_SETTLE_MS = 2_000;

export const systemClock: ServiceClock = {
  now: () => Date.now(),
  wait: (milliseconds) => sleep(milliseconds),
};

export async function waitUntilSteadilyRunning(
  serviceName: string,
  observe: () => Promise<ReadinessObservation>,
  clock: ServiceClock,
): Promise<void> {
  const deadline = clock.now() + READINESS_TIMEOUT_MS;
  let runningSince: number | null = null;
  for (;;) {
    const observation = await observe();
    if (observation.kind === "failed") {
      throw new Error(observation.reason);
    }
    if (observation.kind === "running") {
      runningSince ??= clock.now();
      if (clock.now() - runningSince >= READINESS_SETTLE_MS) {
        return;
      }
    } else {
      runningSince = null;
      if (clock.now() >= deadline) {
        throw new Error(
          `${serviceName} was still ${observation.state} after ${READINESS_TIMEOUT_MS / 1000} s`,
        );
      }
    }
    await clock.wait(READINESS_POLL_INTERVAL_MS);
  }
}
