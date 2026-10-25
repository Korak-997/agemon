const SETTLING_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export interface PublishedRelease {
  version: string;
  publishedAt: string;
  yanked: boolean;
}

export interface CommitSummary {
  sha: string;
  committedAt: string;
}

function unexpectedResponse(detail: string): Error {
  return new Error(`unexpected response: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasSettled(publishedAt: string, now: Date): boolean {
  const publishedAtMs = Date.parse(publishedAt);
  return (
    Number.isFinite(publishedAtMs) &&
    now.getTime() - publishedAtMs >= SETTLING_PERIOD_MS
  );
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function newestSettledVersion(
  releases: PublishedRelease[],
  now: Date,
): string | undefined {
  return releases
    .filter(
      (release) => !release.yanked && hasSettled(release.publishedAt, now),
    )
    .map((release) => release.version)
    .sort(compareVersions)
    .at(-1);
}

export function npmReleases(packument: unknown): PublishedRelease[] {
  if (
    !isRecord(packument) ||
    !isRecord(packument.time) ||
    !isRecord(packument.versions)
  ) {
    throw unexpectedResponse("the npm packument has no time or versions map");
  }
  const publishedVersions = packument.versions;
  return Object.entries(packument.time)
    .filter(
      (entry): entry is [string, string] =>
        EXACT_VERSION_PATTERN.test(entry[0]) &&
        typeof entry[1] === "string" &&
        Object.hasOwn(publishedVersions, entry[0]),
    )
    .map(([version, publishedAt]) => ({ version, publishedAt, yanked: false }));
}

interface PypiFile {
  upload_time_iso_8601?: unknown;
  yanked?: unknown;
}

export function pypiReleases(project: unknown): PublishedRelease[] {
  if (!isRecord(project) || !isRecord(project.releases)) {
    throw unexpectedResponse("the PyPI project has no releases map");
  }
  const releases: PublishedRelease[] = [];
  for (const [version, files] of Object.entries(project.releases)) {
    if (!EXACT_VERSION_PATTERN.test(version) || !Array.isArray(files)) {
      continue;
    }
    const uploadTimes = (files as PypiFile[])
      .map((file) => file.upload_time_iso_8601)
      .filter(
        (uploadTime): uploadTime is string => typeof uploadTime === "string",
      )
      .sort();
    const firstUpload = uploadTimes[0];
    if (!firstUpload) {
      continue;
    }
    releases.push({
      version,
      publishedAt: firstUpload,
      yanked: (files as PypiFile[]).every((file) => file.yanked === true),
    });
  }
  return releases;
}

export function githubCommitSummaries(commits: unknown): CommitSummary[] {
  if (!Array.isArray(commits)) {
    throw unexpectedResponse("the GitHub commit list is not an array");
  }
  return commits.map((commit: unknown) => {
    const committedAt =
      isRecord(commit) &&
      isRecord(commit.commit) &&
      isRecord(commit.commit.committer)
        ? commit.commit.committer.date
        : undefined;
    if (
      !isRecord(commit) ||
      typeof commit.sha !== "string" ||
      typeof committedAt !== "string"
    ) {
      throw unexpectedResponse("a GitHub commit has no sha or committer date");
    }
    return { sha: commit.sha, committedAt };
  });
}

export interface NewestSettledCommitInput {
  pinnedCommittedAt: string;
  commits: CommitSummary[];
  now: Date;
}

export function newestSettledCommitAfterPin(
  input: NewestSettledCommitInput,
): string | undefined {
  for (const commit of input.commits) {
    if (!FULL_COMMIT_PATTERN.test(commit.sha)) {
      throw unexpectedResponse("a commit id is not a full hex SHA");
    }
  }
  const pinnedCommittedAtMs = Date.parse(input.pinnedCommittedAt);
  return input.commits
    .filter(
      (commit) =>
        hasSettled(commit.committedAt, input.now) &&
        Date.parse(commit.committedAt) > pinnedCommittedAtMs,
    )
    .sort(
      (left, right) =>
        Date.parse(left.committedAt) - Date.parse(right.committedAt),
    )
    .at(-1)?.sha;
}
