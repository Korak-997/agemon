import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RefusedFileError } from "../../../../src/core/files.js";
import {
  createLaunchdServiceManager,
  parseLaunchdJobState,
} from "../../../../src/platform/service-manager/darwin.js";
import type {
  RunCommand,
  RunCommandResult,
} from "../../../../src/platform/service-manager/index.js";
import {
  escapePlistString,
  readPlistString,
} from "../../../../src/platform/service-manager/launch-agent-files.js";
import type { ServiceClock } from "../../../../src/platform/service-manager/readiness.js";

const UID = 501;
const LABEL = "dev.agemon.crg.repo-0123abcd";
const PLIST = `${LABEL}.plist`;
const TARGET = `gui/${UID}/${LABEL}`;
const LAUNCHCTL = "/bin/launchctl";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directory of createdTempDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "agemon-launchd-test-"));
  createdTempDirectories.push(home);
  return home;
}

function plistFor(label: string, workingDirectory: string): string {
  return [
    "<plist><dict>",
    "  <key>Label</key>",
    `  <string>${escapePlistString(label)}</string>`,
    "  <key>WorkingDirectory</key>",
    `  <string>${escapePlistString(workingDirectory)}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
}

function printOutput(state: string, runs: number, lastExit = "(never exited)") {
  return `${TARGET} = {\n\tactive count = 1\n\tstate = ${state}\n\truns = ${runs}\n\tlast exit code = ${lastExit}\n}\n`;
}

const OK: RunCommandResult = { code: 0, stdout: "", stderr: "" };
const NOT_FOUND: RunCommandResult = {
  code: 113,
  stdout: "",
  stderr: `Could not find service "${LABEL}" in domain for user gui: ${UID}`,
};

interface FakeLaunchd {
  run: RunCommand;
  calls: string[];
  loaded: boolean;
}

function createFakeLaunchd(
  options: {
    initiallyLoaded?: boolean;
    print?: (printIndex: number) => RunCommandResult;
    bootstrap?: (bootstrapIndex: number) => RunCommandResult;
    bootout?: () => RunCommandResult;
    printsLoadedAfterBootout?: number;
    printDisabled?: string;
  } = {},
): FakeLaunchd {
  const fake: FakeLaunchd = {
    calls: [],
    loaded: options.initiallyLoaded ?? false,
    run: async () => OK,
  };
  let bootstrapIndex = 0;
  let printIndex = 0;
  let loadedPrintsLeft = 0;
  fake.run = async (command, args) => {
    expect(command).toBe(LAUNCHCTL);
    fake.calls.push(args.join(" "));
    switch (args[0]) {
      case "print": {
        if (loadedPrintsLeft > 0) {
          loadedPrintsLeft -= 1;
          return { code: 0, stdout: printOutput("running", 1), stderr: "" };
        }
        if (!fake.loaded) {
          return NOT_FOUND;
        }
        return (
          options.print?.(printIndex++) ?? {
            code: 0,
            stdout: printOutput("running", 1),
            stderr: "",
          }
        );
      }
      case "bootstrap": {
        const result = options.bootstrap?.(bootstrapIndex++) ?? OK;
        fake.loaded ||= result.code === 0;
        return result;
      }
      case "bootout": {
        const wasLoaded = fake.loaded;
        fake.loaded = false;
        loadedPrintsLeft = options.printsLoadedAfterBootout ?? 0;
        return (
          options.bootout?.() ??
          (wasLoaded ? OK : { code: 3, stdout: "", stderr: "No such process" })
        );
      }
      case "print-disabled":
        return { code: 0, stdout: options.printDisabled ?? "", stderr: "" };
      default:
        throw new Error(`unexpected launchctl ${args.join(" ")}`);
    }
  };
  return fake;
}

function createClock(): ServiceClock {
  let now = 0;
  return {
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  };
}

async function createManager(fake: FakeLaunchd, home?: string) {
  const homeDir = home ?? (await createHome());
  return {
    homeDir,
    plistPath: join(homeDir, "Library", "LaunchAgents", PLIST),
    manager: createLaunchdServiceManager({
      run: fake.run,
      homeDir,
      uid: UID,
      clock: createClock(),
    }),
  };
}

const ATTEMPT = { label: "launchd", unitContents: plistFor(LABEL, "/repo") };

describe("launchd service manager — register", () => {
  it("writes the plist 0644, bootstraps it in the GUI domain and waits until it runs", async () => {
    const fake = createFakeLaunchd();
    const { manager, plistPath } = await createManager(fake);

    const result = await manager.registerAutostart({
      unitName: PLIST,
      attempts: [ATTEMPT],
    });

    expect(manager.kind).toBe("launchd");
    expect(result).toEqual({
      unitPath: plistPath,
      attemptLabel: "launchd",
      failedAttempts: [],
    });
    expect((await stat(plistPath)).mode & 0o777).toBe(0o644);
    expect(await readFile(plistPath, "utf8")).toBe(ATTEMPT.unitContents);
    expect(fake.calls).toContain(`bootstrap gui/${UID} ${plistPath}`);
  });

  it("resets an existing plist's mode to 0644", async () => {
    const fake = createFakeLaunchd();
    const { manager, plistPath, homeDir } = await createManager(fake);
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, "old", { mode: 0o666 });

    await manager.registerAutostart({ unitName: PLIST, attempts: [ATTEMPT] });

    expect((await stat(plistPath)).mode & 0o777).toBe(0o644);
  });

  it("boots out an already loaded job before bootstrapping it again", async () => {
    const fake = createFakeLaunchd({ initiallyLoaded: true });
    const { manager } = await createManager(fake);

    await manager.registerAutostart({ unitName: PLIST, attempts: [ATTEMPT] });

    const bootout = fake.calls.indexOf(`bootout ${TARGET}`);
    const bootstrap = fake.calls.findIndex((call) =>
      call.startsWith("bootstrap"),
    );
    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(bootout).toBeLessThan(bootstrap);
  });

  it.each([5, 37])("retries bootstrap once after exit %i", async (exitCode) => {
    const fake = createFakeLaunchd({
      bootstrap: (index) =>
        index === 0
          ? { code: exitCode, stdout: "", stderr: "Bootstrap failed" }
          : OK,
    });
    const { manager } = await createManager(fake);

    await manager.registerAutostart({ unitName: PLIST, attempts: [ATTEMPT] });

    expect(
      fake.calls.filter((call) => call.startsWith("bootstrap")),
    ).toHaveLength(2);
  });

  it("names launchctl enable when the job is disabled", async () => {
    const fake = createFakeLaunchd({
      bootstrap: () => ({ code: 5, stdout: "", stderr: "Input/output error" }),
      printDisabled: `disabled services = {\n\t"${LABEL}" => disabled\n}\n`,
    });
    const { manager } = await createManager(fake);

    await expect(
      manager.registerAutostart({ unitName: PLIST, attempts: [ATTEMPT] }),
    ).rejects.toThrow(`run 'launchctl enable ${TARGET}'`);
  });

  it("explains a missing GUI session when print cannot find the domain", async () => {
    const fake = createFakeLaunchd({ initiallyLoaded: true });
    const original = fake.run;
    fake.run = async (command, args, options) =>
      args[0] === "print"
        ? { code: 1, stdout: "", stderr: "Could not find domain for port" }
        : original(command, args, options);
    const { manager } = await createManager(fake);

    await expect(
      manager.registerAutostart({ unitName: PLIST, attempts: [ATTEMPT] }),
    ).rejects.toThrow("log in to this Mac's desktop session");
  });

  it("explains a missing GUI session", async () => {
    const fake = createFakeLaunchd({
      bootstrap: () => ({
        code: 125,
        stdout: "",
        stderr:
          "Bootstrap failed: 125: Domain does not support specified action",
      }),
    });
    const { manager } = await createManager(fake);

    await expect(
      manager.registerAutostart({ unitName: PLIST, attempts: [ATTEMPT] }),
    ).rejects.toThrow("log in to this Mac's desktop session");
  });

  it.each([
    ["restarts", printOutput("running", 2), "restarted 1 time(s)"],
    [
      "exits non-zero",
      printOutput("not running", 1, "1"),
      "exited with code 1",
    ],
    ["stops", printOutput("not running", 1, "0"), "is not running"],
    [
      "waits to respawn",
      printOutput("spawn scheduled", 1, "0"),
      "is spawn scheduled",
    ],
  ])(
    "fails and cleans up when the job %s",
    async (_label, failedPrint, message) => {
      const fake = createFakeLaunchd({
        print: (index) =>
          index === 0
            ? { code: 0, stdout: printOutput("running", 1), stderr: "" }
            : { code: 0, stdout: failedPrint, stderr: "" },
      });
      const { manager, plistPath } = await createManager(fake);

      await expect(
        manager.registerAutostart({ unitName: PLIST, attempts: [ATTEMPT] }),
      ).rejects.toThrow(message);

      expect(fake.loaded).toBe(false);
      await expect(stat(plistPath)).rejects.toThrow();
    },
  );

  it("times out on output it does not recognise, quoting it", async () => {
    const fake = createFakeLaunchd({
      print: () => ({
        code: 0,
        stdout: "something new from Apple",
        stderr: "",
      }),
    });
    const { manager } = await createManager(fake);

    await expect(
      manager.registerAutostart({ unitName: PLIST, attempts: [ATTEMPT] }),
    ).rejects.toThrow(
      `${LABEL} was still unrecognised (something new from Apple) after 10 s`,
    );
  });

  it("neutralises control characters from launchctl in the error", async () => {
    const fake = createFakeLaunchd({
      print: () => ({
        code: 0,
        stdout: printOutput("\u001b[31mspawning", 0),
        stderr: "",
      }),
    });
    const { manager } = await createManager(fake);

    const failure = await manager
      .registerAutostart({ unitName: PLIST, attempts: [ATTEMPT] })
      .catch((error: Error) => error.message);

    expect(failure).toContain("was still ?[31mspawning after 10 s");
    expect(failure).not.toContain("\u001b");
  });

  it("lists manual cleanup when the job will not unload", async () => {
    const fake = createFakeLaunchd({
      print: (index) =>
        index === 0
          ? { code: 0, stdout: printOutput("running", 2), stderr: "" }
          : { code: 0, stdout: printOutput("running", 2), stderr: "" },
      printsLoadedAfterBootout: 1_000,
    });
    const { manager } = await createManager(fake);

    await expect(
      manager.registerAutostart({ unitName: PLIST, attempts: [ATTEMPT] }),
    ).rejects.toThrow(
      `Cleanup also failed; run these yourself: launchctl bootout ${TARGET}`,
    );
  });

  it("refuses a plist path that is a symlink", async () => {
    const fake = createFakeLaunchd();
    const { manager, plistPath, homeDir } = await createManager(fake);
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await symlink(join(homeDir, "elsewhere"), plistPath);

    await expect(
      manager.registerAutostart({ unitName: PLIST, attempts: [ATTEMPT] }),
    ).rejects.toThrow("not a regular file");
    expect(fake.calls.some((call) => call.startsWith("bootstrap"))).toBe(false);
  });

  it("refuses names that are not agemon launch agents", async () => {
    const { manager } = await createManager(createFakeLaunchd());

    for (const unitName of [
      "com.apple.Finder.plist",
      "dev.agemon.crg.repo.plist",
      "../dev.agemon.crg.repo-0123abcd.plist",
    ]) {
      expect(() => manager.unitPathFor(unitName)).toThrow(RefusedFileError);
      await expect(manager.isActive(unitName)).rejects.toThrow(
        RefusedFileError,
      );
    }
  });
});

describe("launchd service manager — unregister and state", () => {
  it.each([
    ["exit 0", OK],
    [
      "exit 3 (older macOS)",
      { code: 3, stdout: "", stderr: "No such process" },
    ],
    ["exit 113", NOT_FOUND],
  ])("treats bootout %s as gone once print says so", async (_label, result) => {
    const fake = createFakeLaunchd({
      initiallyLoaded: true,
      bootout: () => result,
    });
    const { manager, plistPath, homeDir } = await createManager(fake);
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, plistFor(LABEL, "/repo"));

    await manager.unregisterAutostart({ unitName: PLIST });

    await expect(stat(plistPath)).rejects.toThrow();
  });

  it("waits for a slow teardown", async () => {
    const fake = createFakeLaunchd({
      initiallyLoaded: true,
      printsLoadedAfterBootout: 3,
    });
    const { manager } = await createManager(fake);

    await manager.unregisterAutostart({ unitName: PLIST });

    expect(fake.calls.filter((call) => call.startsWith("print"))).toHaveLength(
      4,
    );
  });

  it("fails when the job is still loaded after the teardown window", async () => {
    const fake = createFakeLaunchd({
      initiallyLoaded: true,
      printsLoadedAfterBootout: 1_000,
    });
    const { manager } = await createManager(fake);

    await expect(
      manager.unregisterAutostart({ unitName: PLIST }),
    ).rejects.toThrow(`${LABEL} is still loaded 5 s after launchctl bootout`);
  });

  it("refuses to boot out a plist whose Label differs from its name", async () => {
    const fake = createFakeLaunchd({ initiallyLoaded: true });
    const { manager, plistPath, homeDir } = await createManager(fake);
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, plistFor("com.example.other", "/repo"));

    await expect(
      manager.unregisterAutostart({ unitName: PLIST }),
    ).rejects.toThrow(RefusedFileError);
    expect(fake.calls.some((call) => call.startsWith("bootout"))).toBe(false);
  });

  it("reports active only for a running job", async () => {
    const running = createFakeLaunchd({ initiallyLoaded: true });
    const stopped = createFakeLaunchd({
      initiallyLoaded: true,
      print: () => ({
        code: 0,
        stdout: printOutput("not running", 1),
        stderr: "",
      }),
    });

    expect(
      await (await createManager(running)).manager.isActive(PLIST),
    ).toEqual({
      active: true,
    });
    expect(
      await (await createManager(stopped)).manager.isActive(PLIST),
    ).toEqual({
      active: false,
    });
    expect(
      await (await createManager(createFakeLaunchd())).manager.isActive(PLIST),
    ).toEqual({ active: false });
  });

  it("reads WorkingDirectory back, and never treats an unreadable plist as missing", async () => {
    const { manager, plistPath, homeDir } = await createManager(
      createFakeLaunchd(),
    );
    expect(await manager.readUnitWorkingDirectory(PLIST)).toBeNull();

    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, plistFor(LABEL, "/repos/a & b"));
    expect(await manager.readUnitWorkingDirectory(PLIST)).toBe("/repos/a & b");

    for (const contents of [
      "bplist00binary",
      plistFor(LABEL, "/a").replace(
        "</dict>",
        "<key>WorkingDirectory</key><string>/b</string></dict>",
      ),
      "<plist><dict><key>Label</key><string>x</string></dict></plist>",
      `<plist><dict><!-- <key>WorkingDirectory</key><string>/decoy</string> --><key>Label</key><string>${LABEL}</string></dict></plist>`,
      `<plist><dict><key>Label</key><string>${LABEL}</string><key>Note</key><string><![CDATA[<key>WorkingDirectory</key><string>/decoy</string>]]></string></dict></plist>`,
    ]) {
      await writeFile(plistPath, contents);
      await expect(manager.readUnitWorkingDirectory(PLIST)).rejects.toThrow(
        RefusedFileError,
      );
    }
  });

  it("finds a remaining agemon launch agent", async () => {
    const { manager, homeDir } = await createManager(createFakeLaunchd());
    expect(await manager.findAgemonDaemonUnit()).toBeNull();

    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(
      join(homeDir, "Library", "LaunchAgents", "com.example.plist"),
      "",
    );
    await writeFile(join(homeDir, "Library", "LaunchAgents", PLIST), "");

    expect(await manager.findAgemonDaemonUnit()).toBe(PLIST);
  });

  it("has no linger", async () => {
    const { manager } = await createManager(createFakeLaunchd());

    await expect(manager.isLingerEnabled()).rejects.toThrow(
      "launchd has no user linger",
    );
  });
});

describe("launchctl print parsing", () => {
  it("reads state, runs and the last exit code", () => {
    expect(parseLaunchdJobState(printOutput("running", 1))).toEqual({
      state: "running",
      runs: 1,
      lastExitCode: null,
    });
    expect(parseLaunchdJobState(printOutput("not running", 3, "78"))).toEqual({
      state: "not running",
      runs: 3,
      lastExitCode: 78,
    });
  });

  it("round-trips escaped plist strings", () => {
    const contents = plistFor(LABEL, `/a/<b>&"c'`);

    expect(readPlistString(contents, "WorkingDirectory", "/x.plist")).toBe(
      `/a/<b>&"c'`,
    );
    expect(readPlistString(contents, "Label", "/x.plist")).toBe(LABEL);
  });
});
