import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const RUNS_AGAINST_REAL_TOOLS = process.env.AGEMON_REAL_TOOLS === "1";
const FILE_WITH_CONSOLE_LOG = "scripts/marketplace.ts";

describe.skipIf(!RUNS_AGAINST_REAL_TOOLS)("ast-grep on PATH", () => {
  it("finds console.log calls with a structural pattern", () => {
    const matches = execFileSync(
      "ast-grep",
      ["run", "-p", "console.log($A)", FILE_WITH_CONSOLE_LOG],
      { encoding: "utf8" },
    );

    expect(matches).toContain("console.log(");
  });
});
