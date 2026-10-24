import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const isolatedStateHome = mkdtempSync(join(tmpdir(), "agemon-test-state-"));
process.env.XDG_STATE_HOME = isolatedStateHome;

afterAll(() => {
  rmSync(isolatedStateHome, { recursive: true, force: true });
});
