import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RunCommand,
  RunCommandResult,
} from "../../../../src/platform/service-manager/index.js";
import { createLinuxServiceManager } from "../../../../src/platform/service-manager/linux.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

interface CommandCall {
  command: string;
  args: string[];
}

function createRunStub(
  implementation: (
    command: string,
    args: string[],
    index: number,
  ) => RunCommandResult,
): { run: RunCommand; calls: CommandCall[] } {
  const calls: CommandCall[] = [];
  const run: RunCommand = async (command, args) => {
    calls.push({ command, args });
    return implementation(command, args, calls.length - 1);
  };

  return { run, calls };
}

describe("linux service manager", () => {
  it("registers autostart without enabling linger when already enabled", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agemon-linux-service-test-"));
    createdTempDirectories.push(homeDir);

    const { run, calls } = createRunStub((command, args) => {
      if (
        command === "loginctl" &&
        args.join(" ") === "show-user tester --property=Linger --value"
      ) {
        return { code: 0, stdout: "yes\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const serviceManager = createLinuxServiceManager({
      run,
      homeDir,
      user: "tester",
    });

    const registration = await serviceManager.registerAutostart({
      unitName: "agemon.service",
      unitContents: "[Service]\nExecStart=true\n",
    });

    expect(registration.lingerEnabledByAgemon).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.command === "loginctl" &&
          call.args.join(" ") === "enable-linger tester",
      ),
    ).toBe(false);

    const writtenUnitContents = await readFile(registration.unitPath, "utf8");
    expect(writtenUnitContents).toContain("ExecStart=true");
  });

  it("enables linger when registering and linger is off", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agemon-linux-service-test-"));
    createdTempDirectories.push(homeDir);

    const { run, calls } = createRunStub((command, args) => {
      if (
        command === "loginctl" &&
        args.join(" ") === "show-user tester --property=Linger --value"
      ) {
        return { code: 0, stdout: "no\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const serviceManager = createLinuxServiceManager({
      run,
      homeDir,
      user: "tester",
    });

    const registration = await serviceManager.registerAutostart({
      unitName: "agemon.service",
      unitContents: "[Service]\nExecStart=true\n",
    });

    expect(registration.lingerEnabledByAgemon).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.command === "loginctl" &&
          call.args.join(" ") === "enable-linger tester",
      ),
    ).toBe(true);
  });

  it("unregisters even when systemctl disable reports missing unit", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agemon-linux-service-test-"));
    createdTempDirectories.push(homeDir);

    const { run, calls } = createRunStub((command, args) => {
      if (
        command === "systemctl" &&
        args.join(" ") === "--user disable --now agemon.service"
      ) {
        return {
          code: 1,
          stdout: "",
          stderr: "Unit agemon.service not loaded.",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const serviceManager = createLinuxServiceManager({
      run,
      homeDir,
      user: "tester",
    });

    await serviceManager.unregisterAutostart({
      unitName: "agemon.service",
      disableLinger: false,
    });

    expect(
      calls.some(
        (call) =>
          call.command === "systemctl" &&
          call.args.join(" ") === "--user daemon-reload",
      ),
    ).toBe(true);
  });

  it("throws when unregister disable fails for a non-missing error", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agemon-linux-service-test-"));
    createdTempDirectories.push(homeDir);

    const { run } = createRunStub((command, args) => {
      if (
        command === "systemctl" &&
        args.join(" ") === "--user disable --now agemon.service"
      ) {
        return {
          code: 1,
          stdout: "",
          stderr: "permission denied",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const serviceManager = createLinuxServiceManager({
      run,
      homeDir,
      user: "tester",
    });

    await expect(
      serviceManager.unregisterAutostart({
        unitName: "agemon.service",
        disableLinger: false,
      }),
    ).rejects.toThrow("permission denied");
  });

  it("disables linger during unregister when requested", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agemon-linux-service-test-"));
    createdTempDirectories.push(homeDir);

    const { run, calls } = createRunStub(() => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));

    const serviceManager = createLinuxServiceManager({
      run,
      homeDir,
      user: "tester",
    });

    await serviceManager.unregisterAutostart({
      unitName: "agemon.service",
      disableLinger: true,
    });

    expect(
      calls.some(
        (call) =>
          call.command === "loginctl" &&
          call.args.join(" ") === "disable-linger tester",
      ),
    ).toBe(true);
  });
});
