const SETTLING_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

export interface PublishedRelease {
  version: string;
  publishedAt: string;
  withdrawn: boolean;
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
      (release) => !release.withdrawn && hasSettled(release.publishedAt, now),
    )
    .map((release) => release.version)
    .sort(compareVersions)
    .at(-1);
}

export function pinnedReleaseProblem(
  releases: PublishedRelease[],
  pinned: string,
): string | undefined {
  const pinnedRelease = releases.find((release) => release.version === pinned);
  if (pinnedRelease === undefined) {
    return "not published";
  }
  return pinnedRelease.withdrawn ? "withdrawn upstream" : undefined;
}

const INSTALL_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export function declaredInstallDependencies(
  packument: unknown,
  version: string,
): string[] {
  const manifest =
    isRecord(packument) && isRecord(packument.versions)
      ? packument.versions[version]
      : undefined;
  if (!isRecord(manifest)) {
    throw unexpectedResponse(
      `the npm packument has no manifest for ${version}`,
    );
  }
  return INSTALL_DEPENDENCY_FIELDS.flatMap((field) => {
    const dependencies = manifest[field];
    return isRecord(dependencies) ? Object.keys(dependencies) : [];
  });
}

function isDeprecated(manifest: unknown): boolean {
  return (
    isRecord(manifest) &&
    typeof manifest.deprecated === "string" &&
    manifest.deprecated !== ""
  );
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
    .map(([version, publishedAt]) => ({
      version,
      publishedAt,
      withdrawn: isDeprecated(publishedVersions[version]),
    }));
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
      withdrawn: (files as PypiFile[]).every((file) => file.yanked === true),
    });
  }
  return releases;
}

interface GithubRelease {
  tag_name?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

export function githubReleases(releases: unknown): PublishedRelease[] {
  if (!Array.isArray(releases)) {
    throw unexpectedResponse("the GitHub releases response is not a list");
  }
  const published: PublishedRelease[] = [];
  for (const release of releases as GithubRelease[]) {
    if (release.draft !== false || release.prerelease !== false) {
      continue;
    }
    const version =
      typeof release.tag_name === "string"
        ? release.tag_name.replace(/^v/u, "")
        : "";
    if (
      !EXACT_VERSION_PATTERN.test(version) ||
      typeof release.published_at !== "string"
    ) {
      continue;
    }
    published.push({
      version,
      publishedAt: release.published_at,
      withdrawn: false,
    });
  }
  return published;
}
