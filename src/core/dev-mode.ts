import { isSourceCheckout, resolvePackageRoot } from "./install-method.js";

const FAKE_BACKEND_ENV_VARS = [
  "AGEMON_FAKE_SUBPROCESS",
  "AGEMON_FAKE_SERVICES",
] as const;

export function isDevMode(packageRoot?: string): boolean {
  return (
    process.env.AGEMON_DEV === "1" &&
    isSourceCheckout(packageRoot ?? resolvePackageRoot())
  );
}

export function assertFakeBackendsAreDevOnly(packageRoot?: string): void {
  const activeFakeVars = FAKE_BACKEND_ENV_VARS.filter(
    (name) => process.env[name] === "1",
  );
  if (activeFakeVars.length > 0 && !isDevMode(packageRoot)) {
    throw new Error(
      `${activeFakeVars.join(", ")} must never be set outside the sandbox harness — refusing to start.`,
    );
  }
}
