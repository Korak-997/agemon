import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSubprocess } from "../../src/core/subprocess-runner.js";
import { createLaunchdServiceManager } from "../../src/platform/service-manager/darwin.js";
import { escapePlistString } from "../../src/platform/service-manager/launch-agent-files.js";

const RUNS_AGAINST_REAL_LAUNCHD =
  process.platform === "darwin" && process.env.CI !== undefined;
const REAL_LAUNCHD_TIMEOUT_MS = 30_000;

let label = "";
let home = "";

function testPlist(program: string[], workingDirectory: string): string {
  const programArguments = program
    .map((argument) => `    <string>${escapePlistString(argument)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    programArguments,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapePlistString(workingDirectory)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

afterEach(async () => {
  if (!RUNS_AGAINST_REAL_LAUNCHD) {
    return;
  }
  await runSubprocess("/bin/launchctl", [
    "bootout",
    `gui/${process.getuid?.()}/${label}`,
  ]);
  await rm(home, { recursive: true, force: true });
});

describe.runIf(RUNS_AGAINST_REAL_LAUNCHD)("real launchd", () => {
  async function createManager() {
    label = `dev.agemon.crg.ci-${randomBytes(4).toString("hex")}`;
    home = await realpath(await mkdtemp(join(tmpdir(), "agemon-launchd-ci-")));
    return createLaunchdServiceManager({ run: runSubprocess, homeDir: home });
  }

  it(
    "registers, reports, reads back and removes a running agent",
    async () => {
      const manager = await createManager();
      const unitName = `${label}.plist`;

      const registration = await manager.registerAutostart({
        unitName,
        attempts: [
          {
            label: "launchd",
            unitContents: testPlist(["/bin/sleep", "600"], home),
          },
        ],
      });

      expect(registration.attemptLabel).toBe("launchd");
      expect(await manager.isActive(unitName)).toEqual({
        active: true,
        failed: false,
      });
      expect(await manager.readUnitWorkingDirectory(unitName)).toBe(home);

      await manager.unregisterAutostart({ unitName });

      expect(await manager.isActive(unitName)).toEqual({
        active: false,
        failed: false,
      });
      await expect(stat(manager.unitPathFor(unitName))).rejects.toThrow();
    },
    REAL_LAUNCHD_TIMEOUT_MS,
  );

  it(
    "reports an agent that exits as failed and removes it",
    async () => {
      const manager = await createManager();
      const unitName = `${label}.plist`;

      await expect(
        manager.registerAutostart({
          unitName,
          attempts: [
            {
              label: "launchd",
              unitContents: testPlist(["/usr/bin/false"], home),
            },
          ],
        }),
      ).rejects.toThrow(`Could not start ${label}`);

      expect(await manager.isActive(unitName)).toEqual({
        active: false,
        failed: false,
      });
      await expect(stat(manager.unitPathFor(unitName))).rejects.toThrow();
    },
    REAL_LAUNCHD_TIMEOUT_MS,
  );
});
