import { chmodSync } from "node:fs";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { quoteForShlex } from "../../../../src/core/untrusted-text.js";
import type {
  RunCommand,
  RunCommandResult,
} from "../../../../src/platform/service-manager/index.js";
import { createLinuxServiceManager } from "../../../../src/platform/service-manager/linux.js";
import type { ServiceClock } from "../../../../src/platform/service-manager/readiness.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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
  "systemctl --user show agemon.service --property=ActiveState --property=SubState --property=NRestarts";
const START_CALL = "systemctl --user restart agemon.service";
const RESET_FAILED_CALL = "systemctl --user reset-failed agemon.service";
const MAIN_PID_QUERY =
  "systemctl --user show -p MainPID --value agemon.service";
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

async function createManager(
  run: RunCommand,
  options: { procRoot?: string } = {},
) {
  const homeDir = await mkdtemp(join(tmpdir(), "agemon-linux-service-test-"));
  createdTempDirectories.push(homeDir);
  const serviceManager = createLinuxServiceManager({
    run,
    homeDir,
    user: "tester",
    clock: createFakeClock(),
    procRoot: options.procRoot,
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
  it("reads a unit's Environment= lines, unquoting and unescaping them", async () => {
    const { run } = createSystemdStub("no");
    const { serviceManager, unitDirectory } = await createManager(run);
    expect(
      await serviceManager.readUnitEnvironment("agemon.service"),
    ).toBeNull();

    await mkdir(unitDirectory, { recursive: true });
    await writeFile(
      join(unitDirectory, "agemon.service"),
      [
        "[Service]",
        'Environment="GIT_ALLOW_PROTOCOL="',
        'Environment="CRG_HOME=/h/100%% \\"q\\" \\\\x"',
        "Environment=PLAIN=value",
        "UnsetEnvironment=GIT_DIR",
        "",
      ].join("\n"),
    );

    expect(await serviceManager.readUnitEnvironment("agemon.service")).toEqual({
      GIT_ALLOW_PROTOCOL: "",
      CRG_HOME: '/h/100% "q" \\x',
      PLAIN: "value",
    });
  });

  it("reads several assignments on one Environment= line", async () => {
    const { run } = createSystemdStub("no");
    const { serviceManager, unitDirectory } = await createManager(run);
    await mkdir(unitDirectory, { recursive: true });
    await writeFile(
      join(unitDirectory, "agemon.service"),
      '[Service]\nEnvironment="A=1" B=2 "C=x y"\n',
    );

    expect(await serviceManager.readUnitEnvironment("agemon.service")).toEqual({
      A: "1",
      B: "2",
      C: "x y",
    });
  });

  it("registers autostart without ever reading or changing linger", async () => {
    const { run, calls } = createSystemdStub("no");
    const { serviceManager } = await createManager(run);

    const registration = await serviceManager.registerAutostart({
      unitName: "agemon.service",
      attempts: STRICT_AND_COMPAT,
    });

    expect(registration.attemptLabel).toBe("strict");
    expect(calls.some((call) => call.command === "loginctl")).toBe(false);
    const writtenUnitContents = await readFile(registration.unitPath, "utf8");
    expect(writtenUnitContents).toContain("ExecStart=strict");
    expect((await stat(registration.unitPath)).mode & 0o777).toBe(0o644);
    expect(registration.unitPath).toBe(
      serviceManager.unitPathFor("agemon.service"),
    );
  });

  it("strict attempt fails, compat succeeds: the strict unit is removed first", async () => {
    let enableCalls = 0;
    const { run, calls } = createSystemdStub("no", (call) => {
      if (call === START_CALL) {
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

    expect(registration.attemptLabel).toBe("compat");
    expect(
      callsMatching(calls, "systemctl --user disable --now agemon.service"),
    ).toBe(1);
    await expect(readdir(unitDirectory)).resolves.toEqual(["agemon.service"]);
    await expect(readFile(registration.unitPath, "utf8")).resolves.toContain(
      "ExecStart=compat",
    );
  });

  it("both attempts fail: no unit file left, daemon-reload ran, linger untouched", async () => {
    const { run, calls } = createSystemdStub("no", (call) =>
      call === START_CALL ? FAILURE : undefined,
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
    expect(calls.some((call) => call.command === "loginctl")).toBe(false);
  });

  it("both attempts fail and the unit cleanup fails: error lists the manual commands", async () => {
    const { run } = createSystemdStub("no", (call) =>
      call === START_CALL ||
      call === "systemctl --user disable --now agemon.service"
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
      "Cleanup also failed; run these yourself: systemctl --user disable --now agemon.service",
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "quotes a unit path containing ' in the manual cleanup advice",
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), "agemon-o'brien-"));
      createdTempDirectories.push(homeDir);
      const unitDirectory = join(homeDir, ".config", "systemd", "user");
      const { run } = createSystemdStub("no", (call) => {
        if (call === START_CALL) {
          chmodSync(unitDirectory, 0o500);
          return FAILURE;
        }
        return undefined;
      });
      const serviceManager = createLinuxServiceManager({
        run,
        homeDir,
        user: "tester",
        clock: createFakeClock(),
      });

      const failure = (await serviceManager
        .registerAutostart({
          unitName: "agemon.service",
          attempts: [STRICT_AND_COMPAT[0]],
        })
        .catch((error: unknown) => error)) as Error;
      chmodSync(unitDirectory, 0o700);

      expect(failure.message).toContain(
        `rm ${quoteForShlex(join(unitDirectory, "agemon.service"))}`,
      );
      expect(failure.message).toContain("o'\\''brien");
    },
  );

  it.each([
    ["USER names another account", { USER: "someone-else" }],
    [
      "USER, LOGNAME and USERNAME are unset",
      { USER: undefined, LOGNAME: undefined, USERNAME: undefined },
    ],
  ])(
    "names the user by numeric id in every linger command when %s",
    async (_case, environment) => {
      for (const [name, value] of Object.entries(environment)) {
        vi.stubEnv(name, value);
      }
      const uid = String(process.geteuid?.() ?? process.getuid?.());
      const homeDir = await mkdtemp(join(tmpdir(), "agemon-linux-sm-"));
      createdTempDirectories.push(homeDir);
      const { run, calls } = createRunStub((command, args) => {
        const call = [command, ...args].join(" ");
        if (call === `loginctl show-user ${uid} --property=Linger --value`) {
          return { code: 0, stdout: "no\n", stderr: "" };
        }
        return command === "loginctl" && args.at(-1) !== uid
          ? FAILURE
          : SUCCESS;
      });
      const serviceManager = createLinuxServiceManager({
        run,
        homeDir,
        clock: createFakeClock(),
      });

      await expect(serviceManager.isActive("agemon.service")).resolves.toEqual({
        active: true,
        failed: false,
      });
      expect(await serviceManager.isLingerEnabled()).toBe(false);
      await serviceManager.enableLinger();
      await serviceManager.disableLinger();

      expect(
        calls
          .filter((call) => call.command === "loginctl")
          .map((call) => call.args.join(" ")),
      ).toEqual([
        `show-user ${uid} --property=Linger --value`,
        `enable-linger ${uid}`,
        `disable-linger ${uid}`,
      ]);
    },
  );

  it("refuses linger commands when the user id cannot be determined", async () => {
    vi.spyOn(process, "geteuid").mockReturnValue(-1);
    const homeDir = await mkdtemp(join(tmpdir(), "agemon-linux-sm-"));
    createdTempDirectories.push(homeDir);
    const { run, calls } = createSystemdStub("no");
    const serviceManager = createLinuxServiceManager({
      run,
      homeDir,
      clock: createFakeClock(),
    });

    await expect(serviceManager.isLingerEnabled()).rejects.toThrow(
      "cannot determine the current user id",
    );
    expect(calls).toEqual([]);
  });

  it.each([
    ["active", { code: 0, stdout: "active\n", stderr: "" }, true, false],
    ["failed", { code: 3, stdout: "failed\n", stderr: "" }, false, true],
    ["inactive", { code: 3, stdout: "inactive\n", stderr: "" }, false, false],
    [
      "activating (auto-restart)",
      { code: 3, stdout: "activating\n", stderr: "" },
      false,
      false,
    ],
  ])("isActive reports a %s unit", async (_state, reply, active, failed) => {
    const { run, calls } = createSystemdStub("no", (call) =>
      call === "systemctl --user is-active agemon.service" ? reply : undefined,
    );
    const { serviceManager } = await createManager(run);

    await expect(serviceManager.isActive("agemon.service")).resolves.toEqual({
      active,
      failed,
    });
    expect(calls).toHaveLength(1);
  });

  it("each start attempt runs write, daemon-reload, reset-failed, enable, restart, then waits", async () => {
    const { run, calls } = createSystemdStub("no");
    const { serviceManager } = await createManager(run);

    await serviceManager.registerAutostart({
      unitName: "agemon.service",
      attempts: [STRICT_AND_COMPAT[0]],
    });

    expect(
      calls
        .map((call) => [call.command, ...call.args].join(" "))
        .filter((call) => call !== UNIT_STATE_QUERY),
    ).toEqual([
      "systemctl --user daemon-reload",
      RESET_FAILED_CALL,
      "systemctl --user enable agemon.service",
      START_CALL,
    ]);
  });

  it.each([
    ["exactly", "Unit agemon.service not loaded."],
    [
      "after systemctl's prefix",
      "Failed to reset failed state of unit agemon.service: Unit agemon.service not loaded.\n",
    ],
  ])(
    "tolerates reset-failed reporting the unit not loaded (%s)",
    async (_case, stderr) => {
      const { run } = createSystemdStub("no", (call) =>
        call === RESET_FAILED_CALL
          ? { code: 1, stdout: "", stderr }
          : undefined,
      );
      const { serviceManager } = await createManager(run);

      const registration = await serviceManager.registerAutostart({
        unitName: "agemon.service",
        attempts: [STRICT_AND_COMPAT[0]],
      });

      expect(registration.attemptLabel).toBe("strict");
    },
  );

  it.each([
    ["another error", "Access denied"],
    ["another unit not loaded", "Unit other.service not loaded."],
  ])(
    "a reset-failed failure with %s fails the attempt before enable",
    async (_case, stderr) => {
      const { run, calls } = createSystemdStub("no", (call) =>
        call === RESET_FAILED_CALL
          ? { code: 1, stdout: "", stderr }
          : undefined,
      );
      const { serviceManager } = await createManager(run);

      await expect(
        serviceManager.registerAutostart({
          unitName: "agemon.service",
          attempts: [STRICT_AND_COMPAT[0]],
        }),
      ).rejects.toThrow(stderr);
      expect(
        callsMatching(calls, "systemctl --user enable agemon.service"),
      ).toBe(0);
    },
  );

  it("a compat attempt after a failed strict one starts with a reset start limit", async () => {
    let startCalls = 0;
    const { run, calls } = createSystemdStub("no", (call) => {
      if (call === START_CALL) {
        startCalls += 1;
        return startCalls === 1 ? FAILURE : SUCCESS;
      }
      return undefined;
    });
    const { serviceManager } = await createManager(run);

    const registration = await serviceManager.registerAutostart({
      unitName: "agemon.service",
      attempts: STRICT_AND_COMPAT,
    });

    expect(registration.attemptLabel).toBe("compat");
    const sequence = calls.map((call) =>
      [call.command, ...call.args].join(" "),
    );
    const firstStart = sequence.indexOf(START_CALL);
    const secondStart = sequence.lastIndexOf(START_CALL);
    const resetsBetween = sequence
      .slice(firstStart + 1, secondStart)
      .filter((call) => call === RESET_FAILED_CALL);
    expect(resetsBetween).toHaveLength(2);
  });

  it("removing a failed unit tolerates any reset-failed error", async () => {
    let startCalls = 0;
    let resetCalls = 0;
    const { run } = createSystemdStub("no", (call) => {
      if (call === START_CALL) {
        startCalls += 1;
        return startCalls === 1 ? FAILURE : SUCCESS;
      }
      if (call === RESET_FAILED_CALL) {
        resetCalls += 1;
        return resetCalls === 2
          ? { code: 1, stdout: "", stderr: "Access denied" }
          : SUCCESS;
      }
      return undefined;
    });
    const { serviceManager } = await createManager(run);

    const registration = await serviceManager.registerAutostart({
      unitName: "agemon.service",
      attempts: STRICT_AND_COMPAT,
    });

    expect(registration.attemptLabel).toBe("compat");
    expect(resetCalls).toBe(3);
  });

  describe("isSandboxEnforced", () => {
    const USER_MANAGER_NAMESPACE = "mnt:[4026531841]";
    const SANDBOX_NAMESPACE = "mnt:[4026532000]";

    async function createProc(
      processes: Record<string, { namespace?: string; parent?: string }>,
    ) {
      const procRoot = await mkdtemp(join(tmpdir(), "agemon-proc-"));
      createdTempDirectories.push(procRoot);
      for (const [pid, { namespace, parent }] of Object.entries(processes)) {
        await mkdir(join(procRoot, pid, "ns"), { recursive: true });
        if (namespace !== undefined) {
          await symlink(namespace, join(procRoot, pid, "ns", "mnt"));
        }
        if (parent !== undefined) {
          await writeFile(
            join(procRoot, pid, "status"),
            `Name:\tcode-review-gra\nPid:\t${pid}\nPPid:\t${parent}\n`,
          );
        }
      }
      return procRoot;
    }

    async function sandboxEnforced(
      processes: Parameters<typeof createProc>[0],
      mainPid = "4242\n",
    ): Promise<boolean> {
      const procRoot = await createProc(processes);
      const { run } = createSystemdStub("no", (call) =>
        call === MAIN_PID_QUERY
          ? { code: 0, stdout: mainPid, stderr: "" }
          : undefined,
      );
      const { serviceManager } = await createManager(run, { procRoot });
      return serviceManager.isSandboxEnforced("agemon.service");
    }

    it.each([
      ["a namespace of its own", SANDBOX_NAMESPACE, true],
      ["the user manager's namespace", USER_MANAGER_NAMESPACE, false],
    ])(
      "a unit in %s reports enforced=%s",
      async (_case, namespace, enforced) => {
        expect(
          await sandboxEnforced({
            self: { namespace: USER_MANAGER_NAMESPACE },
            "1000": { namespace: USER_MANAGER_NAMESPACE },
            "4242": { namespace, parent: "1000" },
          }),
        ).toBe(enforced);
      },
    );

    it("compares with the user manager, not agemon, when agemon runs in another namespace", async () => {
      expect(
        await sandboxEnforced({
          self: { namespace: "mnt:[4026533333]" },
          "1000": { namespace: USER_MANAGER_NAMESPACE },
          "4242": { namespace: USER_MANAGER_NAMESPACE, parent: "1000" },
        }),
      ).toBe(false);
    });

    it.each([
      [
        "the unit's namespace link",
        {
          "1000": { namespace: USER_MANAGER_NAMESPACE },
          "4242": { parent: "1000" },
        },
      ],
      [
        "the unit's status",
        {
          "1000": { namespace: USER_MANAGER_NAMESPACE },
          "4242": { namespace: SANDBOX_NAMESPACE },
        },
      ],
      [
        "the user manager's namespace link",
        {
          "1000": {},
          "4242": { namespace: SANDBOX_NAMESPACE, parent: "1000" },
        },
      ],
    ])(
      "reports not enforced when %s is unreadable",
      async (_case, processes) => {
        expect(await sandboxEnforced(processes)).toBe(false);
      },
    );

    it.each([["0\n"], ["\n"], ["../self\n"]])(
      "reports not enforced for a main PID of %j",
      async (mainPid) => {
        expect(
          await sandboxEnforced(
            {
              "0": { namespace: SANDBOX_NAMESPACE, parent: "1000" },
              "1000": { namespace: USER_MANAGER_NAMESPACE },
            },
            mainPid,
          ),
        ).toBe(false);
      },
    );
  });

  it("a crash during the readiness window fails the attempt while systemd waits RestartSec", async () => {
    let stateReads = 0;
    const { run } = createSystemdStub("no", (call) => {
      if (call !== UNIT_STATE_QUERY) {
        return undefined;
      }
      stateReads += 1;
      return stateReads === 1
        ? STEADY_ACTIVE
        : {
            code: 0,
            stdout:
              "ActiveState=activating\nSubState=auto-restart\nNRestarts=0\n",
            stderr: "",
          };
    });
    const { serviceManager } = await createManager(run);

    await expect(
      serviceManager.registerAutostart({
        unitName: "agemon.service",
        attempts: [STRICT_AND_COMPAT[0]],
      }),
    ).rejects.toThrow(
      "strict: agemon.service exited and is waiting to restart",
    );
    expect(stateReads).toBe(2);
  });

  it.each([
    ["the linger query fails", FAILURE],
    [
      "linger is neither yes nor no",
      { code: 0, stdout: "maybe\n", stderr: "" },
    ],
  ])("isLingerEnabled refuses to guess (%s)", async (_case, reply) => {
    const { run } = createSystemdStub("yes", (call) =>
      call === LINGER_QUERY ? reply : undefined,
    );
    const { serviceManager } = await createManager(run);

    await expect(serviceManager.isLingerEnabled()).rejects.toThrow();
  });

  it("isLingerEnabled, enableLinger and disableLinger call loginctl for the user", async () => {
    const { run, calls } = createSystemdStub("yes");
    const { serviceManager } = await createManager(run);

    expect(await serviceManager.isLingerEnabled()).toBe(true);
    await serviceManager.enableLinger();
    await serviceManager.disableLinger();

    expect(calls.map((call) => [call.command, ...call.args].join(" "))).toEqual(
      [
        LINGER_QUERY,
        "loginctl enable-linger tester",
        "loginctl disable-linger tester",
      ],
    );
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
  });

  it("an unwritable unit directory fails before any command runs", async () => {
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
      if (call === START_CALL) {
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
    });

    expect(
      calls.some(
        (call) =>
          call.command === "systemctl" &&
          call.args.join(" ") === "--user daemon-reload",
      ),
    ).toBe(true);
  });

  it("bounds a daemon-reload failure message from assertSucceeded", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agemon-linux-service-test-"));
    createdTempDirectories.push(homeDir);
    const stderr = Array.from({ length: 5_000 }, (_, i) => `reload ${i}`).join(
      "\n",
    );
    const { run } = createRunStub((command, args) =>
      command === "systemctl" && args.join(" ") === "--user daemon-reload"
        ? { code: 1, stdout: "", stderr }
        : { code: 0, stdout: "", stderr: "" },
    );
    const serviceManager = createLinuxServiceManager({
      run,
      homeDir,
      user: "tester",
    });

    const failure = (await serviceManager
      .unregisterAutostart({ unitName: "agemon.service" })
      .catch((error: unknown) => error)) as Error;

    expect(failure.message.split("\n").length).toBeLessThanOrEqual(11);
    expect(failure.message).toContain("reload 4999");
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
      }),
    ).rejects.toThrow("permission denied");
  });

  it("bounds a systemctl failure message to the last 10 lines of stderr", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agemon-linux-sm-"));
    createdTempDirectories.push(homeDir);
    const stderr = Array.from({ length: 5_000 }, (_, i) => `unit ${i}`).join(
      "\n",
    );
    const { run } = createRunStub((command) =>
      command === "systemctl"
        ? { code: 1, stdout: "", stderr }
        : { code: 0, stdout: "", stderr: "" },
    );
    const serviceManager = createLinuxServiceManager({
      run,
      homeDir,
      user: "tester",
    });

    const failure = (await serviceManager
      .unregisterAutostart({ unitName: "agemon.service" })
      .catch((error: unknown) => error)) as Error;

    expect(failure.message.split("\n").length).toBeLessThanOrEqual(11);
    expect(failure.message).toContain("unit 4999");
  });

  it("unregister never touches linger", async () => {
    const { run, calls } = createSystemdStub("yes");
    const { serviceManager } = await createManager(run);

    await serviceManager.unregisterAutostart({ unitName: "agemon.service" });

    expect(calls.some((call) => call.command === "loginctl")).toBe(false);
  });

  it.each([
    ["a current-scheme unit", "agemon-crg-daemon-other-0123abcd.service"],
    ["the legacy unit name", "agemon-crg-daemon.service"],
  ])(
    "findAgemonDaemonUnit finds %s and ignores other units",
    async (_case, unitName) => {
      const { run } = createSystemdStub("yes");
      const { serviceManager, unitDirectory } = await createManager(run);
      await mkdir(unitDirectory, { recursive: true });
      await writeFile(join(unitDirectory, "unrelated.service"), "", "utf8");
      expect(await serviceManager.findAgemonDaemonUnit()).toBeNull();

      await writeFile(join(unitDirectory, unitName), "[Service]\n", "utf8");

      expect(await serviceManager.findAgemonDaemonUnit()).toBe(unitName);
    },
  );

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
