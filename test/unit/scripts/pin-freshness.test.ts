import { describe, expect, it } from "vitest";
import {
  compareVersions,
  githubCommitSummaries,
  newestSettledCommitAfterPin,
  newestSettledVersion,
  npmReleases,
  pypiReleases,
} from "../../../scripts/check-pins/freshness.js";

const NOW = new Date("2026-10-25T12:00:00Z");
const EIGHT_DAYS_AGO = "2026-10-17T12:00:00Z";
const SIX_DAYS_AGO = "2026-10-19T12:00:00Z";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

describe("newestSettledVersion", () => {
  it("picks the highest version that is at least 7 days old", () => {
    expect(
      newestSettledVersion(
        [
          {
            version: "0.9.0",
            publishedAt: "2026-09-01T00:00:00Z",
            yanked: false,
          },
          { version: "0.10.0", publishedAt: EIGHT_DAYS_AGO, yanked: false },
          { version: "0.11.0", publishedAt: SIX_DAYS_AGO, yanked: false },
        ],
        NOW,
      ),
    ).toBe("0.10.0");
  });

  it("skips yanked releases", () => {
    expect(
      newestSettledVersion(
        [
          {
            version: "2.3.8",
            publishedAt: "2026-09-01T00:00:00Z",
            yanked: false,
          },
          { version: "2.3.9", publishedAt: EIGHT_DAYS_AGO, yanked: true },
        ],
        NOW,
      ),
    ).toBe("2.3.8");
  });

  it("returns undefined when nothing has settled", () => {
    expect(
      newestSettledVersion(
        [{ version: "1.0.0", publishedAt: SIX_DAYS_AGO, yanked: false }],
        NOW,
      ),
    ).toBeUndefined();
  });
});

describe("npmReleases", () => {
  it("keeps published exact versions and ignores created, modified, prereleases and unpublished ones", () => {
    expect(
      npmReleases({
        time: {
          created: "2026-01-01T00:00:00Z",
          modified: SIX_DAYS_AGO,
          "0.58.0": EIGHT_DAYS_AGO,
          "0.59.0-rc.1": EIGHT_DAYS_AGO,
          "0.59.0": EIGHT_DAYS_AGO,
        },
        versions: { "0.58.0": {}, "0.59.0-rc.1": {} },
      }),
    ).toEqual([
      { version: "0.58.0", publishedAt: EIGHT_DAYS_AGO, yanked: false },
    ]);
  });

  it("rejects a packument without a time map", () => {
    expect(() => npmReleases({ versions: {} })).toThrow("unexpected response");
    expect(() => npmReleases({ time: {} })).toThrow("unexpected response");
  });
});

describe("pypiReleases", () => {
  it("dates each release by its first upload and marks fully yanked ones", () => {
    expect(
      pypiReleases({
        releases: {
          "2.3.9": [
            { upload_time_iso_8601: EIGHT_DAYS_AGO, yanked: false },
            { upload_time_iso_8601: SIX_DAYS_AGO, yanked: false },
          ],
          "2.4.0": [{ upload_time_iso_8601: SIX_DAYS_AGO, yanked: true }],
          "2.5.0": [],
          "3.0.0b1": [{ upload_time_iso_8601: EIGHT_DAYS_AGO, yanked: false }],
        },
      }),
    ).toEqual([
      { version: "2.3.9", publishedAt: EIGHT_DAYS_AGO, yanked: false },
      { version: "2.4.0", publishedAt: SIX_DAYS_AGO, yanked: true },
    ]);
  });

  it("rejects a project without a releases map", () => {
    expect(() => pypiReleases({ info: {} })).toThrow("unexpected response");
  });
});

describe("newestSettledCommitAfterPin", () => {
  it("reports a settled commit newer than the pinned one", () => {
    expect(
      newestSettledCommitAfterPin({
        pinnedCommittedAt: "2026-08-28T00:00:00Z",
        commits: [
          { sha: COMMIT_B, committedAt: SIX_DAYS_AGO },
          { sha: COMMIT_A, committedAt: EIGHT_DAYS_AGO },
        ],
        now: NOW,
      }),
    ).toBe(COMMIT_A);
  });

  it("ignores commits that are older than the pin or not yet settled", () => {
    expect(
      newestSettledCommitAfterPin({
        pinnedCommittedAt: "2026-08-28T00:00:00Z",
        commits: [
          { sha: COMMIT_B, committedAt: SIX_DAYS_AGO },
          { sha: COMMIT_A, committedAt: "2026-08-01T00:00:00Z" },
        ],
        now: NOW,
      }),
    ).toBeUndefined();
  });

  it("rejects a commit id that is not a full hex SHA", () => {
    expect(() =>
      newestSettledCommitAfterPin({
        pinnedCommittedAt: "2026-08-28T00:00:00Z",
        commits: [{ sha: "main; echo pwned", committedAt: EIGHT_DAYS_AGO }],
        now: NOW,
      }),
    ).toThrow("unexpected response");
  });
});

describe("githubCommitSummaries", () => {
  it("reads the sha and committer date of each commit", () => {
    expect(
      githubCommitSummaries([
        { sha: COMMIT_A, commit: { committer: { date: EIGHT_DAYS_AGO } } },
      ]),
    ).toEqual([{ sha: COMMIT_A, committedAt: EIGHT_DAYS_AGO }]);
  });

  it("rejects a response that is not a commit list", () => {
    expect(() => githubCommitSummaries({ message: "Not Found" })).toThrow(
      "unexpected response",
    );
    expect(() => githubCommitSummaries([{ sha: COMMIT_A }])).toThrow(
      "unexpected response",
    );
  });
});

describe("compareVersions", () => {
  it("orders versions numerically, part by part", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("2.3.8", "2.3.9")).toBeLessThan(0);
    expect(compareVersions("1.7.2", "1.7.2")).toBe(0);
  });
});
