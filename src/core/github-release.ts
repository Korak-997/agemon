export const GITHUB_REPOSITORY = "Korak-997/agemon";
export const RELEASE_WORKFLOW = `${GITHUB_REPOSITORY}/.github/workflows/release.yml`;
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;
const RELEASE_DOWNLOAD_BASE_URL = `https://github.com/${GITHUB_REPOSITORY}/releases/download`;
export const CHECKSUMS_ASSET_NAME = "SHA256SUMS";
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const PRERELEASE_CHANNEL_ORDER = ["alpha", "beta", "rc"];
const RELEASE_DOWNLOAD_TIMEOUT_MS = 30_000;
const USER_AGENT = "agemon-update-check";

export function parseReleaseVersion(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const version = value.replace(/^v/, "");
  return RELEASE_VERSION_PATTERN.test(version) ? version : undefined;
}

interface ReleaseVersionParts {
  core: number[];
  prerelease: [channel: number, number: number] | null;
}

function splitReleaseVersion(version: string): ReleaseVersionParts {
  const [core, prerelease] = version.split("-");
  if (prerelease === undefined) {
    return { core: core.split(".").map(Number), prerelease: null };
  }
  const [channel, number] = prerelease.split(".");
  return {
    core: core.split(".").map(Number),
    prerelease: [PRERELEASE_CHANNEL_ORDER.indexOf(channel), Number(number)],
  };
}

export function compareReleaseVersions(left: string, right: string): number {
  const leftParts = splitReleaseVersion(left);
  const rightParts = splitReleaseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts.core[index] - rightParts.core[index];
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  if (leftParts.prerelease === null || rightParts.prerelease === null) {
    return (
      Number(leftParts.prerelease === null) -
      Number(rightParts.prerelease === null)
    );
  }
  const channelDifference = leftParts.prerelease[0] - rightParts.prerelease[0];
  return Math.sign(
    channelDifference || leftParts.prerelease[1] - rightParts.prerelease[1],
  );
}

export async function fetchLatestReleaseVersion(
  signal: AbortSignal,
): Promise<string | undefined> {
  const response = await fetch(LATEST_RELEASE_API_URL, {
    headers: { "User-Agent": USER_AGENT },
    signal,
  });
  if (!response.ok) {
    return undefined;
  }
  const body = (await response.json()) as { tag_name?: unknown };
  return parseReleaseVersion(body.tag_name);
}

export function releaseAssetUrl(version: string, assetName: string): string {
  return `${RELEASE_DOWNLOAD_BASE_URL}/v${version}/${assetName}`;
}

export async function downloadReleaseAsset(
  version: string,
  assetName: string,
  maxBytes: number,
): Promise<Buffer> {
  const response = await fetch(releaseAssetUrl(version, assetName), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(RELEASE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `downloading ${assetName} failed with HTTP ${response.status}`,
    );
  }
  const declaredBytes = Number(response.headers.get("content-length") ?? 0);
  if (declaredBytes > maxBytes) {
    throw new Error(`${assetName} is larger than expected`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > maxBytes) {
    throw new Error(`${assetName} is larger than expected`);
  }
  return body;
}

export function readExpectedChecksum(
  checksums: string,
  assetName: string,
): string {
  const assetLines = checksums
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => {
      const listedName = line.split(/\s+/).at(-1);
      return listedName === assetName || listedName === `*${assetName}`;
    });
  const [hash] = assetLines.length === 1 ? assetLines[0].split("  ") : [];
  if (
    !hash ||
    !SHA256_HEX_PATTERN.test(hash) ||
    assetLines[0] !== `${hash}  ${assetName}`
  ) {
    throw new Error(
      `${CHECKSUMS_ASSET_NAME} has no single valid entry for ${assetName}`,
    );
  }
  return hash;
}
