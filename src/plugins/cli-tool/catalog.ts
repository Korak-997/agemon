import type { PinnedNpmTarball } from "../../core/verified-binary-installer.js";
import {
  AGNIX_BINARY_SHA256,
  AGNIX_NPM_TARBALL,
  AGNIX_PACKAGE_FILE_SHA256,
  AGNIX_RELEASE_ARCHIVE_SHA256,
  AGNIX_VERSION,
} from "../pins.js";
import type { SharedResourceDeclaration } from "../types.js";

export interface PinnedReleaseArchive {
  asset: string;
  sha256: string;
}

export interface CliToolBundleEntry {
  id: string;
  packageName: string;
  version: string;
  binaryName: string;
  commandPathInPackage: string;
  binaryPathInPackage: string;
  packageTarball: PinnedNpmTarball;
  packageFileSha256: Readonly<Record<string, string>>;
  binarySha256: readonly string[];
  archiveMemberName: string;
  releaseDownloadUrl: string;
  releaseArchivesByPlatform: Record<string, PinnedReleaseArchive[]>;
  sharedResource: SharedResourceDeclaration;
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
    commandPathInPackage: "bin/agnix",
    binaryPathInPackage: "bin/agnix-binary",
    packageTarball: AGNIX_NPM_TARBALL,
    packageFileSha256: AGNIX_PACKAGE_FILE_SHA256,
    binarySha256: AGNIX_BINARY_SHA256,
    archiveMemberName: "agnix",
    releaseDownloadUrl: `https://github.com/agent-sh/agnix/releases/download/v${AGNIX_VERSION}`,
    releaseArchivesByPlatform: {
      "linux-x64": [
        agnixArchive("agnix-x86_64-unknown-linux-gnu.tar.gz"),
        agnixArchive("agnix-x86_64-unknown-linux-musl.tar.gz"),
      ],
      "linux-arm64": [agnixArchive("agnix-aarch64-unknown-linux-gnu.tar.gz")],
      "darwin-arm64": [agnixArchive("agnix-aarch64-apple-darwin.tar.gz")],
    },
    sharedResource: {
      id: "npm-global:agnix",
      toolName: "agnix",
      manualRemoveCommand: "npm uninstall --global agnix",
      removalVerb: "uninstall",
      migratesFromRepoLedgers: true,
    },
  },
];
