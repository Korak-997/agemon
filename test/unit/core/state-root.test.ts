import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isUserPrivateGroup,
  type LocalAccounts,
  prepareToolsRoot,
  repositoryStateKey,
  resolveAgemonStateDirectory,
  withRepositoryRunLock,
} from "../../../src/core/state-root.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createStateRoot(): Promise<{
  root: string;
  agemon: string;
  accounts: LocalAccounts;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), "agemon-state-root-"));
  createdTempDirectories.push(sandbox);
  const root = join(sandbox, "state");
  await mkdir(root, { mode: 0o700 });
  vi.stubEnv("XDG_STATE_HOME", root);
  const groupFile = join(sandbox, "group");
  const passwdFile = join(sandbox, "passwd");
  await writeFile(groupFile, "");
  await writeFile(passwdFile, "");
  return {
    root,
    agemon: join(root, "agemon"),
    accounts: {
      uid: userInfo().uid,
      username: "dev",
      groupFile,
      passwdFile,
    },
  };
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("resolveAgemonStateDirectory", () => {
  it("prepare creates the agemon directory with mode 0700", async () => {
    const { agemon, accounts } = await createStateRoot();

    const directory = await resolveAgemonStateDirectory("prepare", accounts);

    expect(directory).toEqual({ path: agemon, tightenedFromMode: null });
    expect(await modeOf(agemon)).toBe(0o700);
  });

  it("check never creates the directory", async () => {
    const { agemon, accounts } = await createStateRoot();

    await resolveAgemonStateDirectory("check", accounts);

    await expect(stat(agemon)).rejects.toThrow();
  });

  it("prepare tightens a 0755 agemon directory and reports it; check leaves it", async () => {
    const { agemon, accounts } = await createStateRoot();
    await mkdir(agemon);
    await chmod(agemon, 0o755);

    await resolveAgemonStateDirectory("check", accounts);
    expect(await modeOf(agemon)).toBe(0o755);

    const directory = await resolveAgemonStateDirectory("prepare", accounts);
    expect(directory.tightenedFromMode).toBe(0o755);
    expect(await modeOf(agemon)).toBe(0o700);
  });

  it("refuses an agemon directory that other users can write", async () => {
    const { agemon, accounts } = await createStateRoot();
    await mkdir(agemon);
    await chmod(agemon, 0o707);

    await expect(
      resolveAgemonStateDirectory("prepare", accounts),
    ).rejects.toThrow(/other users can write to it.*chmod g-w,o-w/);
    expect(await modeOf(agemon)).toBe(0o707);
  });

  it("refuses a group-writable agemon directory whose group is shared", async () => {
    const { agemon, accounts } = await createStateRoot();
    await mkdir(agemon);
    await chmod(agemon, 0o770);

    await expect(
      resolveAgemonStateDirectory("prepare", accounts),
    ).rejects.toThrow(/its group can write to it/);
  });

  it("accepts and tightens a group-writable agemon directory of a user private group", async () => {
    const { agemon, accounts } = await createStateRoot();
    await mkdir(agemon);
    await chmod(agemon, 0o770);
    const gid = (await stat(agemon)).gid;
    await writeFile(accounts.groupFile, `dev:x:${gid}:\n`);
    await writeFile(
      accounts.passwdFile,
      `dev:x:1000:${gid}::/home/dev:/bin/sh\n`,
    );

    const directory = await resolveAgemonStateDirectory("prepare", accounts);

    expect(directory.tightenedFromMode).toBe(0o770);
  });

  it("refuses a symlinked agemon directory", async () => {
    const { root, agemon, accounts } = await createStateRoot();
    await mkdir(join(root, "elsewhere"), { mode: 0o700 });
    await symlink(join(root, "elsewhere"), agemon);

    await expect(
      resolveAgemonStateDirectory("check", accounts),
    ).rejects.toThrow(/not a real directory/);
  });

  it("refuses an agemon directory owned by another user", async () => {
    const { agemon, accounts } = await createStateRoot();
    await mkdir(agemon, { mode: 0o700 });

    await expect(
      resolveAgemonStateDirectory("check", { ...accounts, uid: 123_456 }),
    ).rejects.toThrow(/owned by another user/);
  });

  it("refuses a state root owned by another non-root user", async () => {
    const { accounts } = await createStateRoot();

    await expect(
      resolveAgemonStateDirectory("check", { ...accounts, uid: 123_456 }),
    ).rejects.toThrow(/state.*owned by another user/);
  });

  it("refuses a world-writable, non-sticky state root", async () => {
    const { root, accounts } = await createStateRoot();
    await chmod(root, 0o777);

    await expect(
      resolveAgemonStateDirectory("prepare", accounts),
    ).rejects.toThrow(/other users can write to it/);
  });

  it("accepts a world-writable state root with the sticky bit", async () => {
    const { root, accounts } = await createStateRoot();
    await chmod(root, 0o1777);

    await expect(
      resolveAgemonStateDirectory("prepare", accounts),
    ).resolves.toMatchObject({ tightenedFromMode: null });
  });

  it("prepareToolsRoot goes through the check", async () => {
    const { agemon } = await createStateRoot();
    await mkdir(agemon);
    await chmod(agemon, 0o707);

    await expect(prepareToolsRoot()).rejects.toThrow(/other users can write/);
  });
});

describe("isUserPrivateGroup", () => {
  async function accountsWith(
    group: string,
    passwd: string,
  ): Promise<LocalAccounts> {
    const sandbox = await mkdtemp(join(tmpdir(), "agemon-accounts-"));
    createdTempDirectories.push(sandbox);
    await writeFile(join(sandbox, "group"), group);
    await writeFile(join(sandbox, "passwd"), passwd);
    return {
      uid: 1000,
      username: "dev",
      groupFile: join(sandbox, "group"),
      passwdFile: join(sandbox, "passwd"),
    };
  }

  it("accepts a group named after the user with no other members", async () => {
    const accounts = await accountsWith(
      "dev:x:1000:\n",
      "dev:x:1000:1000::/home/dev:/bin/sh\n",
    );
    expect(await isUserPrivateGroup(1000, accounts)).toBe(true);
  });

  it("refuses a group with listed members", async () => {
    const accounts = await accountsWith(
      "dev:x:1000:alice\n",
      "dev:x:1000:1000::/home/dev:/bin/sh\n",
    );
    expect(await isUserPrivateGroup(1000, accounts)).toBe(false);
  });

  it("refuses when another account has that group as its primary group", async () => {
    const accounts = await accountsWith(
      "dev:x:1000:\n",
      "dev:x:1000:1000::/home/dev:/bin/sh\nbob:x:1001:1000::/home/bob:/bin/sh\n",
    );
    expect(await isUserPrivateGroup(1000, accounts)).toBe(false);
  });

  it("refuses when a second group row shares the gid and lists members", async () => {
    const accounts = await accountsWith(
      "dev:x:1000:\nshared:x:1000:alice\n",
      "dev:x:1000:1000::/home/dev:/bin/sh\n",
    );
    expect(await isUserPrivateGroup(1000, accounts)).toBe(false);
  });

  it("refuses a group named differently", async () => {
    const accounts = await accountsWith("staff:x:1000:\n", "");
    expect(await isUserPrivateGroup(1000, accounts)).toBe(false);
  });

  it("refuses when the account files can't be read", async () => {
    expect(
      await isUserPrivateGroup(1000, {
        uid: 1000,
        username: "dev",
        groupFile: "/nonexistent/group",
        passwdFile: "/nonexistent/passwd",
      }),
    ).toBe(false);
  });
});

describe("withRepositoryRunLock", () => {
  it("a second run in the same repository fails at once, naming the lock", async () => {
    await createStateRoot();
    const repo = await mkdtemp(join(tmpdir(), "agemon-run-lock-"));
    createdTempDirectories.push(repo);
    let release: () => void = () => {};
    let signalHeld: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    const holding = withRepositoryRunLock(
      repo,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          signalHeld();
        }),
    );
    await held;

    await expect(withRepositoryRunLock(repo, async () => {})).rejects.toThrow(
      new RegExp(
        `pid ${process.pid}.*runs/${await repositoryStateKey(repo)}\\.lock`,
      ),
    );
    release();
    await holding;
    await expect(withRepositoryRunLock(repo, async () => "next")).resolves.toBe(
      "next",
    );
  });

  it("two different repositories run at the same time", async () => {
    await createStateRoot();
    const first = await mkdtemp(join(tmpdir(), "agemon-run-lock-a-"));
    const second = await mkdtemp(join(tmpdir(), "agemon-run-lock-b-"));
    createdTempDirectories.push(first, second);
    const order: string[] = [];

    await Promise.all([
      withRepositoryRunLock(first, async () => {
        order.push("first:start");
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push("first:end");
      }),
      withRepositoryRunLock(second, async () => {
        order.push("second");
      }),
    ]);

    expect(order.indexOf("second")).toBeLessThan(order.indexOf("first:end"));
  });
});
