import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoInterruptedApply,
  type NewApplyJournal,
  readJournals,
  resolveJournalDirectory,
  writeJournal,
} from "../../../src/core/apply-journal.js";
import { MAX_READ_FILE_BYTES } from "../../../src/core/files.js";

const PLAN_ID = "0123456789abcdef";
const createdTempDirectories: string[] = [];
const isolatedStateHome = process.env.XDG_STATE_HOME;

afterEach(async () => {
  process.env.XDG_STATE_HOME = isolatedStateHome;
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "agemon-journal-test-"));
  createdTempDirectories.push(repo);
  return repo;
}

function newJournal(overrides: Partial<NewApplyJournal> = {}): NewApplyJournal {
  return {
    planId: PLAN_ID,
    startedAt: "2026-10-24T00:00:00.000Z",
    capabilityOrder: ["master-prompt"],
    ledgerBefore: [],
    snapshots: [
      {
        targetPath: "AGENTS.md",
        previousContents: "original\n",
        stagedFingerprint: "abc",
      },
    ],
    ...overrides,
  };
}

async function plantJournal(
  repo: string,
  fileName: string,
  contents: unknown,
): Promise<string> {
  const directory = await resolveJournalDirectory(repo);
  await mkdir(directory, { recursive: true });
  const path = join(directory, fileName);
  await writeFile(path, JSON.stringify(contents), "utf8");
  return path;
}

async function validJournalRecord(
  repo: string,
): Promise<Record<string, unknown>> {
  return {
    version: 1,
    repoRoot: await realpath(repo),
    ...newJournal(),
  };
}

describe("apply journal location", () => {
  it("lives under the test run's isolated state home, never the real one", async () => {
    const directory = await resolveJournalDirectory(await createRepo());

    expect(isolatedStateHome).toBeDefined();
    expect(directory.startsWith(join(isolatedStateHome ?? "", "agemon"))).toBe(
      true,
    );
    expect(directory.startsWith(join(homedir(), ".local", "state"))).toBe(
      false,
    );
  });

  it.each(["", "relative/state"])(
    "ignores XDG_STATE_HOME=%j and never resolves inside the repo",
    async (value) => {
      const repo = await createRepo();
      process.env.XDG_STATE_HOME = value;

      const directory = await resolveJournalDirectory(repo);

      expect(directory.startsWith(join(homedir(), ".local", "state"))).toBe(
        true,
      );
      expect(directory.startsWith(repo)).toBe(false);
    },
  );

  it("keys the directory by the repo's real path", async () => {
    const repo = await createRepo();
    const link = join(await createRepo(), "link");
    await symlink(repo, link);

    expect(await resolveJournalDirectory(link)).toBe(
      await resolveJournalDirectory(repo),
    );
  });
});

describe("writeJournal", () => {
  it("creates the directory 0700 and the file 0600, outside the repo", async () => {
    const repo = await createRepo();

    const { path } = await writeJournal(repo, newJournal());

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, "..")).then((s) => s.mode)) & 0o777).toBe(
      0o700,
    );
    expect(path.startsWith(repo)).toBe(false);
    await expect(readdir(repo)).resolves.toEqual([]);
  });

  it("round-trips through readJournals", async () => {
    const repo = await createRepo();
    const { path, journal } = await writeJournal(repo, newJournal());

    await expect(readJournals(repo)).resolves.toEqual([{ path, journal }]);
  });

  it("refuses a journal larger than the read cap and writes nothing", async () => {
    const repo = await createRepo();
    const halfCap = "x".repeat(MAX_READ_FILE_BYTES / 2 + 1);

    await expect(
      writeJournal(
        repo,
        newJournal({
          snapshots: [
            {
              targetPath: "a.md",
              previousContents: halfCap,
              stagedFingerprint: null,
            },
            {
              targetPath: "b.md",
              previousContents: halfCap,
              stagedFingerprint: null,
            },
          ],
        }),
      ),
    ).rejects.toThrow(
      "Refusing to apply: the rollback journal would exceed 8 MiB (2 rule files). Shrink them or apply fewer capabilities with --only.",
    );
    await expect(readJournals(repo)).resolves.toEqual([]);
  });
});

describe("readJournals validation", () => {
  it("returns nothing when no journal directory exists", async () => {
    await expect(readJournals(await createRepo())).resolves.toEqual([]);
  });

  it("ignores files that are not journals, such as interrupted temp writes", async () => {
    const repo = await createRepo();
    await plantJournal(repo, `${PLAN_ID}.json.tmp-1-x`, {});
    await plantJournal(repo, "notes.txt", {});

    await expect(readJournals(repo)).resolves.toEqual([]);
  });

  it.each<[string, (record: Record<string, unknown>) => void, RegExp]>([
    [
      "a plan id that differs from the file name",
      (record) => {
        record.planId = "fedcba9876543210";
      },
      /plan id does not match its file name/,
    ],
    [
      "another repository's root",
      (record) => {
        record.repoRoot = "/somewhere/else";
      },
      /belongs to another repository \(\/somewhere\/else\)/,
    ],
    [
      "an unknown version",
      (record) => {
        record.version = 2;
      },
      /unknown version 2/,
    ],
    [
      "a missing field",
      (record) => {
        delete record.startedAt;
      },
      /'startedAt' must be a string/,
    ],
    [
      "a wrong snapshot type",
      (record) => {
        record.snapshots = [
          { targetPath: "a.md", previousContents: 3, stagedFingerprint: null },
        ];
      },
      /'snapshots\[0\]\.previousContents' must be a string or null/,
    ],
    [
      "a malformed ledger entry",
      (record) => {
        record.ledgerBefore = [{ id: 1 }];
      },
      /'ledgerBefore' is not a list of valid ledger entries/,
    ],
    [
      "a control character in a target path",
      (record) => {
        record.snapshots = [
          {
            targetPath: "a\u001b.md",
            previousContents: null,
            stagedFingerprint: null,
          },
        ];
      },
      /'snapshots\[0\]\.targetPath' must be a string without control characters/,
    ],
  ])("refuses %s, naming the journal path", async (_label, mutate, detail) => {
    const repo = await createRepo();
    const record = await validJournalRecord(repo);
    mutate(record);
    const path = await plantJournal(repo, `${PLAN_ID}.json`, record);

    const failure = readJournals(repo);

    await expect(failure).rejects.toThrow(detail);
    await expect(readJournals(repo)).rejects.toThrow(
      `The interrupted-apply journal ${path} is invalid:`,
    );
  });

  it("refuses a journal that is not JSON", async () => {
    const repo = await createRepo();
    const directory = await resolveJournalDirectory(repo);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${PLAN_ID}.json`), "{", "utf8");

    await expect(readJournals(repo)).rejects.toThrow(/is invalid: .*JSON/);
  });
});

describe("assertNoInterruptedApply", () => {
  it("passes when no journal exists", async () => {
    await expect(
      assertNoInterruptedApply(await createRepo()),
    ).resolves.toBeUndefined();
  });

  it("points to 'agemon recover' when a journal exists", async () => {
    const repo = await createRepo();
    await writeJournal(repo, newJournal());

    await expect(assertNoInterruptedApply(repo)).rejects.toThrow(
      `An earlier apply (plan ${PLAN_ID}, started 2026-10-24T00:00:00.000Z) was interrupted. Run 'agemon recover' to restore the files it changed.`,
    );
  });
});
