import { describe, expect, it } from "vitest";
import {
  type ReadinessObservation,
  type ServiceClock,
  waitUntilSteadilyRunning,
} from "../../../../src/platform/service-manager/readiness.js";

function createClock(): ServiceClock {
  let now = 0;
  return {
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  };
}

function observing(...observations: ReadinessObservation[]) {
  let index = 0;
  return async () => observations[Math.min(index++, observations.length - 1)];
}

describe("waitUntilSteadilyRunning", () => {
  it("returns once the service has run for the whole settle window", async () => {
    await expect(
      waitUntilSteadilyRunning(
        "svc",
        observing({ kind: "pending", state: "starting" }, { kind: "running" }),
        createClock(),
      ),
    ).resolves.toBeUndefined();
  });

  it("restarts the settle window when the service drops out of running", async () => {
    const observations: ReadinessObservation[] = [
      { kind: "running" },
      { kind: "running" },
      { kind: "pending", state: "starting" },
      { kind: "failed", reason: "svc is failed" },
    ];

    await expect(
      waitUntilSteadilyRunning(
        "svc",
        observing(...observations),
        createClock(),
      ),
    ).rejects.toThrow("svc is failed");
  });

  it("times out while pending", async () => {
    await expect(
      waitUntilSteadilyRunning(
        "svc",
        observing({ kind: "pending", state: "activating" }),
        createClock(),
      ),
    ).rejects.toThrow("svc was still activating after 10 s");
  });
});
