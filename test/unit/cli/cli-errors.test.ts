import { describe, expect, it } from "vitest";
import { exitCodeFor, renderCliError } from "../../../src/cli/index.js";
import { ApplyRollbackError } from "../../../src/core/apply.js";
import { ApplyInterruptedError } from "../../../src/core/interruption.js";

const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);

function rollbackCausedBy(cause: unknown): ApplyRollbackError {
  return new ApplyRollbackError(
    { message: "x", restored: [], reverted: [], kept: [], manualCleanup: [] },
    cause,
  );
}

describe("exitCodeFor", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)("maps a rollback caused by %s to %i", (signal, exitCode) => {
    expect(
      exitCodeFor(rollbackCausedBy(new ApplyInterruptedError(signal))),
    ).toBe(exitCode);
  });

  it("maps every other error to 1", () => {
    expect(exitCodeFor(rollbackCausedBy(new Error("boom")))).toBe(1);
    expect(exitCodeFor(new Error("boom"))).toBe(1);
    expect(exitCodeFor("boom")).toBe(1);
  });
});

describe("renderCliError", () => {
  it("escapes terminal control sequences in the message", () => {
    const rendered = renderCliError(
      `Unknown plugin id(s): ${ESCAPE}]0;pwned${BELL}`,
    );

    expect(rendered).toContain("Unknown plugin id(s): ?]0;pwned?");
    expect(rendered).not.toContain(`${ESCAPE}]`);
    expect(rendered).not.toContain(BELL);
  });

  it("hints at --allow-unignored-state for a symlinked .gitignore", () => {
    const rendered = renderCliError(
      "Refusing to write /repo/.gitignore: it is not a regular file (agemon does not write through symlinks or special files).",
    );

    expect(rendered).toContain("replace the .gitignore symlink");
    expect(rendered).toContain("--allow-unignored-state.");
  });

  it("points at a git failure as a cause of the isolation refusal", () => {
    const rendered = renderCliError(
      "Refusing to write .agemon/ state: /.agemon/ is not git-ignored. Re-run interactively (or with --yes) so agemon can add it, or pass --allow-unignored-state to override.",
    );

    expect(rendered).toContain("fix that git error first");
  });

  it.each([
    "code-review-graph failed: process isolation is not supported on this kernel",
    "pipx failed: warning: /tmp/build is not git-ignored",
  ])("gives no isolation hint for an unrelated error: %s", (message) => {
    expect(renderCliError(message)).not.toContain(
      "add /.agemon/ to .gitignore",
    );
  });
});
