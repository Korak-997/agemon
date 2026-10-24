import { cp, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];
const updateCheck = vi.hoisted(() => ({
  startUpdateCheck: vi.fn(),
}));
vi.mock("../../src/core/update-check.js", () => updateCheck);

const { runCli } = await import("../../src/cli/index.js");

const fixturesRoot = join(process.cwd(), "test/fixtures");
let sandboxDirectory: string;
let originalCwd: string;

beforeEach(async () => {
  events.length = 0;
  updateCheck.startUpdateCheck.mockImplementation(() => ({
    finish: vi.fn(async () => {
      events.push("update-finish");
      return "not-updated";
    }),
    abort: vi.fn(() => events.push("update-abort")),
  }));
  sandboxDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "agemon-update-wiring-test-")),
  );
  const repoDirectory = join(sandboxDirectory, "repo");
  await cp(join(fixturesRoot, "clean-repo"), repoDirectory, {
    recursive: true,
  });
  const osReleasePath = join(sandboxDirectory, "os-release");
  await writeFile(osReleasePath, "ID=ubuntu\n", "utf8");
  vi.stubEnv("HOME", join(sandboxDirectory, "home"));
  vi.stubEnv("AGEMON_DEV", "1");
  vi.stubEnv("AGEMON_FAKE_SUBPROCESS", "1");
  vi.stubEnv("AGEMON_FAKE_SERVICES", "1");
  vi.stubEnv("AGEMON_OS_RELEASE_PATH", osReleasePath);
  vi.spyOn(console, "log").mockImplementation(() => {
    events.push("log");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  originalCwd = process.cwd();
  process.chdir(repoDirectory);
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  updateCheck.startUpdateCheck.mockReset();
  await rm(sandboxDirectory, { recursive: true, force: true });
});

describe("update check wiring", () => {
  it.each([["status"], ["inspect"], ["plan"], ["recover", "--dry-run"]])(
    "never starts for %s",
    async (...argv) => {
      await runCli(argv);

      expect(updateCheck.startUpdateCheck).not.toHaveBeenCalled();
    },
  );

  it("offers the update only after the command's summary", async () => {
    expect(await runCli(["--yes", "--skip-daemon"])).toBe(0);

    expect(updateCheck.startUpdateCheck).toHaveBeenCalledTimes(1);
    expect(events.slice(-2)).toEqual(["update-finish", "update-abort"]);
    expect(events.lastIndexOf("log")).toBeLessThan(
      events.indexOf("update-finish"),
    );
  });

  it("skips the offer and still aborts the lookup when the command fails", async () => {
    expect(await runCli(["--yes", "--only", "nope"])).toBe(1);

    expect(events).not.toContain("update-finish");
    expect(events).toContain("update-abort");
  });

  it("does not offer the update after a run that exits 2", async () => {
    expect(await runCli(["--yes", "--skip-daemon"])).toBe(0);
    await rm(join(process.cwd(), ".agemon"), { recursive: true, force: true });

    expect(await runCli(["--skip-daemon"])).toBe(2);

    expect(events.slice(-1)).toEqual(["update-abort"]);
    expect(events.filter((event) => event === "update-finish")).toHaveLength(1);
  });
});
