import { AGNIX_RELEASE_ARCHIVE_SHA256, AGNIX_VERSION } from "../pins.js";

export interface PinnedReleaseArchive {
  asset: string;
  sha256: string;
}

export interface CliToolBundleEntry {
  id: string;
  packageName: string;
  version: string;
  binaryName: string;
  binaryPathInPackage: string;
  archiveMemberName: string;
  releaseDownloadUrl: string;
  releaseArchivesByPlatform: Record<string, PinnedReleaseArchive[]>;
}

function agnixArchive(
  asset: keyof typeof AGNIX_RELEASE_ARCHIVE_SHA256,
): PinnedReleaseArchive {
  return { asset, sha256: AGNIX_RELEASE_ARCHIVE_SHA256[asset] };
}

export const CLI_TOOL_BUNDLE: CliToolBundleEntry[] = [
  {
    id: "agnix",
    packageName: "agnix",
    version: AGNIX_VERSION,
    binaryName: "agnix",
    binaryPathInPackage: "bin/agnix-binary",
    archiveMemberName: "agnix",
    releaseDownloadUrl: `https://github.com/agent-sh/agnix/releases/download/v${AGNIX_VERSION}`,
    releaseArchivesByPlatform: {
      "linux-x64": [
        agnixArchive("agnix-x86_64-unknown-linux-gnu.tar.gz"),
        agnixArchive("agnix-x86_64-unknown-linux-musl.tar.gz"),
      ],
      "linux-arm64": [agnixArchive("agnix-aarch64-unknown-linux-gnu.tar.gz")],
    },
  },
];
