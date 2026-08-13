const FAKE_BACKEND_ENV_VARS = [
  "AGEMON_FAKE_SUBPROCESS",
  "AGEMON_FAKE_SERVICES",
] as const;

/**
 * `AGEMON_FAKE_SUBPROCESS`/`AGEMON_FAKE_SERVICES` (see docs/plan.md §2.4) swap in fake
 * backends for the sandbox harness. Belt-and-suspenders against ever shipping a build
 * where they're silently on: they may only be set alongside `AGEMON_DEV`, which only
 * `scripts/sandbox.ts` and `npm run dev` set.
 */
export function assertFakeBackendsAreDevOnly(): void {
  const activeFakeVars = FAKE_BACKEND_ENV_VARS.filter(
    (name) => process.env[name] === "1",
  );
  if (activeFakeVars.length > 0 && process.env.AGEMON_DEV !== "1") {
    throw new Error(
      `${activeFakeVars.join(", ")} must never be set outside the sandbox harness — refusing to start.`,
    );
  }
}
