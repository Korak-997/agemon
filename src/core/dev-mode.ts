const FAKE_BACKEND_ENV_VARS = [
  "AGEMON_FAKE_SUBPROCESS",
  "AGEMON_FAKE_SERVICES",
] as const;

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
