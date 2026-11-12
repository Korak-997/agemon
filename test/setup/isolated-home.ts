import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const isolatedStateHome = mkdtempSync(join(tmpdir(), "agemon-test-state-"));
process.env.XDG_STATE_HOME = isolatedStateHome;

const isolatedHome = realpathSync(
  mkdtempSync(join(tmpdir(), "agemon-test-home-")),
);
process.env.HOME = isolatedHome;

afterAll(() => {
  rmSync(isolatedStateHome, { recursive: true, force: true });
  rmSync(isolatedHome, { recursive: true, force: true });
});
