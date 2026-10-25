import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProcessProbe,
  parseProcessStartTime,
  withFileLock,
} from "../../../src/core/file-lock.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createLockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agemon-file-lock-"));
  createdTempDirectories.push(directory);
  return join(directory, "machine.lock");
}

const THIS_BOOT = "boot-a";
const DEAD_PID = 999_999;

function probeWith(overrides: Partial<ProcessProbe> = {}): ProcessProbe {
  return {
    bootId: async () => THIS_BOOT,
    startTime: async (pid) => (pid === DEAD_PID ? null : `start-${pid}`),
    exists: (pid) => pid !== DEAD_PID,
    ...overrides,
  };
}

function ownerJson(owner: {
  token?: string;
  pid: number;
  bootId?: string | null;
  startTime?: string | null;
}): string {
  return JSON.stringify({
    token: owner.token ?? "other-token",
    pid: owner.pid,
    bootId: owner.bootId === undefined ? THIS_BOOT : owner.bootId,
    startTime:
      owner.startTime === undefined ? `start-${owner.pid}` : owner.startTime,
    acquiredAt: "2026-10-25T00:00:00.000Z",
  });
}

describe("withFileLock", () => {
  it("two holders serialize: the second runs after the first releases", async () => {
    const lockPath = await createLockPath();
    const events: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });

    const first = withFileLock(
      lockPath,
      async () => {
        events.push("first:start");
        signalFirstStarted();
        await firstMayFinish;
        events.push("first:end");
      },
      { waitMs: 10_000, pollMs: 5, probe: probeWith() },
    );
    await firstStarted;
    const second = withFileLock(
      lockPath,
      async () => {
        events.push("second");
      },
      { waitMs: 10_000, pollMs: 5, probe: probeWith() },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("removes its lock file when the work throws", async () => {
    const lockPath = await createLockPath();
    await expect(
      withFileLock(
        lockPath,
        async () => {
          throw new Error("boom");
        },
        { waitMs: 100, probe: probeWith() },
      ),
    ).rejects.toThrow("boom");
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  it("a lock left by a dead pid is broken and taken", async () => {
    const lockPath = await createLockPath();
    await writeFile(lockPath, ownerJson({ pid: DEAD_PID, startTime: "gone" }));

    await expect(
      withFileLock(lockPath, async () => "ran", {
        waitMs: 1_000,
        pollMs: 5,
        probe: probeWith(),
      }),
    ).resolves.toBe("ran");
  });

  it("a lock from another boot is stale", async () => {
    const lockPath = await createLockPath();
    await writeFile(lockPath, ownerJson({ pid: 4242, bootId: "boot-old" }));

    await expect(
      withFileLock(lockPath, async () => "ran", {
        waitMs: 1_000,
        pollMs: 5,
        probe: probeWith(),
      }),
    ).resolves.toBe("ran");
  });

  it("a reused pid with a different start time is stale", async () => {
    const lockPath = await createLockPath();
    await writeFile(
      lockPath,
      ownerJson({ pid: 4242, startTime: "start-of-the-old-process" }),
    );

    await expect(
      withFileLock(lockPath, async () => "ran", {
        waitMs: 1_000,
        pollMs: 5,
        probe: probeWith(),
      }),
    ).resolves.toBe("ran");
  });

  it("a live owner is waited for and the timeout names the pid and the path", async () => {
    const lockPath = await createLockPath();
    await writeFile(lockPath, ownerJson({ pid: 4242 }));

    await expect(
      withFileLock(lockPath, async () => "ran", {
        waitMs: 50,
        pollMs: 5,
        probe: probeWith(),
      }),
    ).rejects.toThrow(
      new RegExp(`pid 4242.*${lockPath.replaceAll("/", "\\/")}`),
    );
  });

  it("without /proc, liveness falls back to the pid alone", async () => {
    const lockPath = await createLockPath();
    await writeFile(
      lockPath,
      ownerJson({ pid: 4242, bootId: null, startTime: null }),
    );
    const noProc = probeWith({
      bootId: async () => null,
      startTime: async () => null,
    });

    await expect(
      withFileLock(lockPath, async () => "ran", {
        waitMs: 50,
        pollMs: 5,
        probe: noProc,
      }),
    ).rejects.toThrow(/pid 4242/);

    await writeFile(
      lockPath,
      ownerJson({ pid: DEAD_PID, bootId: null, startTime: null }),
    );
    await expect(
      withFileLock(lockPath, async () => "ran", {
        waitMs: 1_000,
        pollMs: 5,
        probe: noProc,
      }),
    ).resolves.toBe("ran");
  });

  it.each([0, -1, 1.5, 1])(
    "pid %s is not trusted: the lock is stale only by age",
    async (pid) => {
      const lockPath = await createLockPath();
      await writeFile(lockPath, ownerJson({ pid }));

      await expect(
        withFileLock(lockPath, async () => "ran", {
          waitMs: 50,
          pollMs: 5,
          probe: probeWith(),
        }),
      ).rejects.toThrow(/holds/);

      const oldEnough = new Date(Date.now() - 60_000);
      await utimes(lockPath, oldEnough, oldEnough);
      await expect(
        withFileLock(lockPath, async () => "ran", {
          waitMs: 1_000,
          pollMs: 5,
          probe: probeWith(),
        }),
      ).resolves.toBe("ran");
    },
  );

  it("unparseable lock content is stale only after 30 s", async () => {
    const lockPath = await createLockPath();
    await writeFile(lockPath, "");

    await expect(
      withFileLock(lockPath, async () => "ran", {
        waitMs: 50,
        pollMs: 5,
        probe: probeWith(),
      }),
    ).rejects.toThrow(/holds/);

    const oldEnough = new Date(Date.now() - 31_000);
    await utimes(lockPath, oldEnough, oldEnough);
    await expect(
      withFileLock(lockPath, async () => "ran", {
        waitMs: 1_000,
        pollMs: 5,
        probe: probeWith(),
      }),
    ).resolves.toBe("ran");
  });

  it("three racers on a stale lock: exactly one holds it at a time", async () => {
    const lockPath = await createLockPath();
    await writeFile(lockPath, ownerJson({ pid: DEAD_PID, startTime: "gone" }));
    let inside = 0;
    let maximumInside = 0;
    const racer = () =>
      withFileLock(
        lockPath,
        async () => {
          inside += 1;
          maximumInside = Math.max(maximumInside, inside);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inside -= 1;
        },
        { waitMs: 5_000, pollMs: 2, probe: probeWith() },
      );

    await Promise.all([racer(), racer(), racer()]);

    expect(maximumInside).toBe(1);
  });

  it("a breaker never removes a lock whose owner changed after it was judged stale", async () => {
    const lockPath = await createLockPath();
    await writeFile(lockPath, ownerJson({ pid: DEAD_PID, startTime: "gone" }));
    const freshOwner = ownerJson({ token: "fresh", pid: 4242 });
    let replaced = false;
    const racingProbe = probeWith({
      startTime: async (pid) => {
        if (pid === DEAD_PID && !replaced) {
          replaced = true;
          await writeFile(lockPath, freshOwner);
        }
        return pid === DEAD_PID ? null : `start-${pid}`;
      },
    });

    await expect(
      withFileLock(lockPath, async () => "ran", {
        waitMs: 50,
        pollMs: 5,
        probe: racingProbe,
      }),
    ).rejects.toThrow(/holds/);
    expect(await readFile(lockPath, "utf8")).toBe(freshOwner);
  });

  it("release does not delete a lock that another run now holds", async () => {
    const lockPath = await createLockPath();
    const otherOwner = ownerJson({ token: "someone-else", pid: 4242 });

    await withFileLock(
      lockPath,
      async () => {
        await writeFile(lockPath, otherOwner);
      },
      { waitMs: 100, probe: probeWith() },
    );

    expect(await readFile(lockPath, "utf8")).toBe(otherOwner);
  });

  it("assertStillHeld fails once the lock file was replaced", async () => {
    const lockPath = await createLockPath();

    await expect(
      withFileLock(
        lockPath,
        async (lock) => {
          await lock.assertStillHeld();
          await writeFile(lockPath, ownerJson({ pid: 4242 }));
          await lock.assertStillHeld();
        },
        { waitMs: 100, probe: probeWith() },
      ),
    ).rejects.toThrow(/removed or replaced/);
  });

  it("taking the same lock twice in one call chain throws instead of deadlocking", async () => {
    const lockPath = await createLockPath();

    await expect(
      withFileLock(
        lockPath,
        () =>
          withFileLock(lockPath, async () => "inner", {
            waitMs: 100,
            probe: probeWith(),
          }),
        { waitMs: 100, probe: probeWith() },
      ),
    ).rejects.toThrow(/already holding/);
  });
});

describe("parseProcessStartTime", () => {
  it("reads field 22 after the last parenthesis, even with a crafted name", () => {
    const fieldsAfterName = Array.from({ length: 20 }, (_, index) =>
      String(index + 3),
    );
    fieldsAfterName[19] = "777";
    const stat = `4242 (evil) 1 2 3) ${fieldsAfterName.join(" ")}`;

    expect(parseProcessStartTime(stat)).toBe("777");
  });

  it("returns null for truncated content", () => {
    expect(parseProcessStartTime("4242 (name) S 1")).toBeNull();
    expect(parseProcessStartTime("garbage")).toBeNull();
  });
});
