import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RunCommand,
  RunCommandResult,
} from "../../../../src/platform/service-manager/index.js";
import {
  createLinuxServiceManager,
  type ServiceClock,
} from "../../../../src/platform/service-manager/linux.js";

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

const LINGER_QUERY = "loginctl show-user tester --property=Linger --value";
const UNIT_STATE_QUERY =
  "systemctl --user show agemon.service --property=ActiveState --property=NRestarts";
const STEADY_ACTIVE: RunCommandResult = {
  code: 0,
  stdout: "ActiveState=active\nNRestarts=0\n",
  stderr: "",
};
const SUCCESS: RunCommandResult = { code: 0, stdout: "", stderr: "" };
const FAILURE: RunCommandResult = { code: 1, stdout: "", stderr: "boom" };

function createSystemdStub(
  linger: string,
  respond: (call: string) => RunCommandResult | undefined = () => undefined,
) {
  return createRunStub((command, args) => {
    const call = [command, ...args].join(" ");
    const scripted = respond(call);
    if (scripted) {
      return scripted;
    }
    if (call === LINGER_QUERY) {
      return { code: 0, stdout: `${linger}\n`, stderr: "" };
    }
    if (call === UNIT_STATE_QUERY) {
      return STEADY_ACTIVE;
    }
    return SUCCESS;
  });
}

function createFakeClock(): ServiceClock {
  let now = 0;
  return {
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  };
}

async function createManager(run: RunCommand) {
  const homeDir = await mkdtemp(join(tmpdir(), "agemon-linux-service-test-"));
  createdTempDirectories.push(homeDir);
  const serviceManager = createLinuxServiceManager({
    run,
    homeDir,
    user: "tester",
    clock: createFakeClock(),
  });
  return {
    serviceManager,
    unitDirectory: join(homeDir, ".config", "systemd", "user"),
  };
}

const STRICT_AND_COMPAT = [
  { label: "strict", unitContents: "[Service]\nExecStart=strict\n" },
  { label: "compat", unitContents: "[Service]\nExecStart=compat\n" },
];

function callsMatching(calls: CommandCall[], expected: string): number {
  return calls.filter(
    (call) => [call.command, ...call.args].join(" ") === expected,
  ).length;
}

describe("linux service manager", () => {
  it("registers autostart without enabling linger when already enabled", async () => {
    const { run, calls } = createSystemdStub("yes");
    const { serviceManager } = await createManager(run);

    const registration = await serviceManager.registerAutostart({
      unitName: "agemon.service",
      attempts: STRICT_AND_COMPAT,
    });

    expect(registration.lingerEnabledByAgemon).toBe(false);
    expect(registration.attemptLabel).toBe("strict");
    expect(callsMatching(calls, "loginctl enable-linger tester")).toBe(0);

    const writtenUnitContents = await readFile(registration.unitPath, "utf8");
    expect(writtenUnitContents).toContain("ExecStart=strict");
    expect((await stat(registration.unitPath)).mode & 0o777).toBe(0o644);
  });

  it("enables linger when registering and linger is off", async () => {
    const { run, calls } = createSystemdStub("no");
    const { serviceManager } = await createManager(run);

    const registration = await serviceManager.registerAutostart({
      unitName: "agemon.service",
      attempts: STRICT_AND_COMPAT,
    });

    expect(registration.lingerEnabledByAgemon).toBe(true);
    expect(callsMatching(calls, "loginctl enable-linger tester")).toBe(1);
  });

  it("strict attempt fails, compat succeeds: lingerEnabledByAgemon stays true", async () => {
    let enableCalls = 0;
    const { run, calls } = createSystemdStub("no", (call) => {
      if (call === "systemctl --user enable --now agemon.service") {
        enableCalls += 1;
        return enableCalls === 1 ? FAILURE : SUCCESS;
      }
      return undefined;
    });
    const { serviceManager, unitDirectory } = await createManager(run);

    const registration = await serviceManager.registerAutostart({
      unitName: "agemon.service",
      attempts: STRICT_AND_COMPAT,
    });

    expect(registration).toMatchObject({
      lingerEnabledByAgemon: true,
      attemptLabel: "compat",
    });
    expect(callsMatching(calls, LINGER_QUERY)).toBe(1);
    expect(callsMatching(calls, "loginctl enable-linger tester")).toBe(1);
    expect(callsMatching(calls, "loginctl disable-linger tester")).toBe(0);
    expect(
      callsMatching(calls, "systemctl --user disable --now agemon.service"),
    ).toBe(1);
    await expect(readdir(unitDirectory)).resolves.toEqual(["agemon.service"]);
    await expect(readFile(registration.unitPath, "utf8")).resolves.toContain(
      "ExecStart=compat",
    );
  });

  it("both attempts fail: no unit file left, daemon-reload ran, linger disabled again", async () => {
    const { run, calls } = createSystemdStub("no", (call) =>
      call === "systemctl --user enable --now agemon.service"
        ? FAILURE
        : undefined,
    );
    const { serviceManager, unitDirectory } = await createManager(run);

    await expect(
      serviceManager.registerAutostart({
        unitName: "agemon.service",
        attempts: STRICT_AND_COMPAT,
      }),
    ).rejects.toThrow(
      /^Could not start agemon.service \(strict: boom; compat: boom\)\.$/,
    );
    await expect(readdir(unitDirectory)).resolves.toEqual([]);
    expect(callsMatching(calls, "systemctl --user daemon-reload")).toBe(4);
    expect(callsMatching(calls, "loginctl disable-linger tester")).toBe(1);
    expect(calls.at(-1)).toEqual({
      command: "loginctl",
      args: ["disable-linger", "tester"],
    });
  });

  it("both attempts fail and disable-linger fails: error lists the manual commands", async () => {
    const { run } = createSystemdStub("no", (call) =>
      call === "systemctl --user enable --now agemon.service" ||
      call === "systemctl --user disable --now agemon.service" ||
      call === "loginctl disable-linger tester"
        ? FAILURE
        : undefined,
    );
    const { serviceManager } = await createManager(run);

    await expect(
      serviceManager.registerAutostart({
        unitName: "agemon.service",
        attempts: STRICT_AND_COMPAT,
      }),
    ).rejects.toThrow(
      "Cleanup also failed; run these yourself: systemctl --user disable --now agemon.service; loginctl disable-linger tester",
    );
  });

  it("does not disable linger it found already on when every attempt fails", async () => {
    const { run, calls } = createSystemdStub("yes", (call) =>
      call === "systemctl --user enable --now agemon.service"
        ? FAILURE
        : undefined,
    );
    const { serviceManager } = await createManager(run);

    await expect(
      serviceManager.registerAutostart({
        unitName: "agemon.service",
        attempts: STRICT_AND_COMPAT,
      }),
    ).rejects.toThrow(/Could not start agemon.service/);
    expect(callsMatching(calls, "loginctl disable-linger tester")).toBe(0);
  });

  it.each([
    ["the linger query fails", FAILURE],
    [
      "linger is neither yes nor no",
      { code: 0, stdout: "maybe\n", stderr: "" },
    ],
  ])("linger read failure writes no unit file (%s)", async (_case, reply) => {
    const { run, calls } = createSystemdStub("yes", (call) =>
      call === LINGER_QUERY ? reply : undefined,
    );
    const { serviceManager, unitDirectory } = await createManager(run);

    await expect(
      serviceManager.registerAutostart({
        unitName: "agemon.service",
        attempts: STRICT_AND_COMPAT,
      }),
    ).rejects.toThrow();
    await expect(readdir(unitDirectory)).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("a unit path that is not a regular file aborts without removing it", async () => {
    const { run, calls } = createSystemdStub("no");
    const { serviceManager, unitDirectory } = await createManager(run);
    await mkdir(unitDirectory, { recursive: true });
    const elsewhere = join(unitDirectory, "..", "elsewhere.service");
    await writeFile(elsewhere, "user's own unit\n", "utf8");
    await symlink(elsewhere, join(unitDirectory, "agemon.service"));

    await expect(
      serviceManager.registerAutostart({
        unitName: "agemon.service",
        attempts: STRICT_AND_COMPAT,
      }),
    ).rejects.toThrow(/^Could not start agemon.service \(strict: /);

    expect(
      (await lstat(join(unitDirectory, "agemon.service"))).isSymbolicLink(),
    ).toBe(true);
    await expect(readFile(elsewhere, "utf8")).resolves.toBe(
      "user's own unit\n",
    );
    expect(
      callsMatching(calls, "systemctl --user disable --now agemon.service"),
    ).toBe(0);
    expect(callsMatching(calls, "loginctl disable-linger tester")).toBe(1);
  });

  it("an unwritable unit directory fails before linger is touched", async () => {
    const { run, calls } = createSystemdStub("no");
    const homeDir = await mkdtemp(join(tmpdir(), "agemon-linux-service-test-"));
    createdTempDirectories.push(homeDir);
    await writeFile(join(homeDir, ".config"), "not a directory\n", "utf8");
    const serviceManager = createLinuxServiceManager({
      run,
      homeDir,
      user: "tester",
      clock: createFakeClock(),
    });

    await expect(
      serviceManager.registerAutostart({
        unitName: "agemon.service",
        attempts: STRICT_AND_COMPAT,
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("crash loop (NRestarts > 0) counts as a failed attempt", async () => {
    let attemptsStarted = 0;
    const { run } = createSystemdStub("yes", (call) => {
      if (call === "systemctl --user enable --now agemon.service") {
        attemptsStarted += 1;
      }
      return call === UNIT_STATE_QUERY && attemptsStarted === 1
        ? {
            code: 0,
            stdout: "NRestarts=1\nActiveState=activating\n",
            stderr: "",
          }
        : undefined;
    });
    const { serviceManager } = await createManager(run);

    const registration = await serviceManager.registerAutostart({
      unitName: "agemon.service",
      attempts: STRICT_AND_COMPAT,
    });

    expect(registration.attemptLabel).toBe("compat");
  });

  it("still activating after the timeout counts as a failed attempt", async () => {
    const { run } = createSystemdStub("yes", (call) =>
      call === UNIT_STATE_QUERY
        ? {
            code: 0,
            stdout: "ActiveState=activating\nNRestarts=0\n",
            stderr: "",
          }
        : undefined,
    );
    const { serviceManager } = await createManager(run);

    await expect(
      serviceManager.registerAutostart({
        unitName: "agemon.service",
        attempts: STRICT_AND_COMPAT,
      }),
    ).rejects.toThrow(
      "strict: agemon.service was still activating after 10 s; compat: agemon.service was still activating after 10 s",
    );
  });

  it("readiness: active held for the settle window succeeds", async () => {
    const { run, calls } = createSystemdStub("yes");
    const { serviceManager } = await createManager(run);

    await serviceManager.registerAutostart({
      unitName: "agemon.service",
      attempts: STRICT_AND_COMPAT,
    });

    expect(callsMatching(calls, UNIT_STATE_QUERY)).toBe(5);
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

  it("keeps linger on unregister while another agemon daemon unit exists", async () => {
    const { run, calls } = createSystemdStub("yes");
    const { serviceManager, unitDirectory } = await createManager(run);
    await mkdir(unitDirectory, { recursive: true });
    await writeFile(
      join(unitDirectory, "agemon-crg-daemon-other-0123abcd.service"),
      "[Service]\n",
      "utf8",
    );
    await writeFile(join(unitDirectory, "unrelated.service"), "", "utf8");

    const result = await serviceManager.unregisterAutostart({
      unitName: "agemon-crg-daemon-mine-89abcdef.service",
      disableLinger: true,
    });

    expect(result).toEqual({
      lingerKeptFor: "agemon-crg-daemon-other-0123abcd.service",
    });
    expect(callsMatching(calls, "loginctl disable-linger tester")).toBe(0);
  });

  it("readUnitWorkingDirectory reads only a regular file in the unit directory", async () => {
    const { run } = createSystemdStub("yes");
    const { serviceManager, unitDirectory } = await createManager(run);
    await mkdir(unitDirectory, { recursive: true });
    await writeFile(
      join(unitDirectory, "real.service"),
      "[Service]\nWorkingDirectory=/first\nWorkingDirectory=/srv/repo %%x\n",
      "utf8",
    );
    await symlink(
      join(unitDirectory, "real.service"),
      join(unitDirectory, "linked.service"),
    );

    await expect(
      serviceManager.readUnitWorkingDirectory("real.service"),
    ).resolves.toBe("/srv/repo %%x");
    await expect(
      serviceManager.readUnitWorkingDirectory("missing.service"),
    ).resolves.toBeNull();
    await expect(
      serviceManager.readUnitWorkingDirectory("linked.service"),
    ).rejects.toThrow();
  });
});
