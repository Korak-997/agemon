import { describe, expect, it } from "vitest";
import {
  buildAgemonArgv,
  buildRunArgv,
  type RunFlags,
} from "../../../scripts/sandbox/argv.js";

const FLAGS: RunFlags = {
  dryRun: false,
  real: false,
  trace: false,
  quiet: false,
  skipDaemon: true,
};

describe("sandbox run argv", () => {
  it("passes --yes to a fake run unless --dry-run", () => {
    expect(buildRunArgv(FLAGS)).toEqual(["--yes", "--skip-daemon"]);
    expect(buildRunArgv({ ...FLAGS, dryRun: true })).toEqual([
      "--dry-run",
      "--skip-daemon",
    ]);
  });

  it("never passes --yes to a run on the real machine", () => {
    expect(buildRunArgv({ ...FLAGS, real: true })).toEqual(["--skip-daemon"]);
  });

  it("leaves the roundtrip's own argv unchanged", () => {
    expect(["--yes", ...buildAgemonArgv({ ...FLAGS, dryRun: false })]).toEqual([
      "--yes",
      "--skip-daemon",
    ]);
  });
});
