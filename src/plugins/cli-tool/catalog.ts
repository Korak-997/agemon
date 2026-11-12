import type {
  PinnedNpmTarball,
  VerifiedArchiveCandidate,
} from "../../core/verified-binary-installer.js";
import {
  AGNIX_BINARY_SHA256,
  AGNIX_NPM_TARBALL,
  AGNIX_PACKAGE_FILE_SHA256,
  AGNIX_RELEASE_ARCHIVE_SHA256,
  AGNIX_VERSION,
} from "../pins.js";
import type { SharedResourceDeclaration } from "../types.js";

export type PinnedReleaseArchive = VerifiedArchiveCandidate;

export interface NpmWrappedInstall {
  kind: "npm-wrapped";
  packageName: string;
  packageTarball: PinnedNpmTarball;
  packageFileSha256: Readonly<Record<string, string>>;
  commandPathInPackage: string;
  binaryPathInPackage: string;
  binarySha256: readonly string[];
}

export interface LinkedBinaryInstall {
  kind: "linked-binary";
}

export interface CliToolBundleEntry {
  id: string;
  version: string;
  binaryName: string;
  install: NpmWrappedInstall | LinkedBinaryInstall;
  releaseArchivesByPlatform: Record<string, PinnedReleaseArchive[]>;
  sharedResource: SharedResourceDeclaration;
}

const AGNIX_RELEASE_DOWNLOAD_URL = `https://github.com/agent-sh/agnix/releases/download/v${AGNIX_VERSION}`;

function agnixArchive(
  asset: keyof typeof AGNIX_RELEASE_ARCHIVE_SHA256,
): PinnedReleaseArchive {
  return {
    url: `${AGNIX_RELEASE_DOWNLOAD_URL}/${asset}`,
    sha256: AGNIX_RELEASE_ARCHIVE_SHA256[asset],
    memberName: "agnix",
  };
}

export const CLI_TOOL_BUNDLE: CliToolBundleEntry[] = [
  {
    id: "agnix",
    version: AGNIX_VERSION,
    binaryName: "agnix",
    install: {
      kind: "npm-wrapped",
      packageName: "agnix",
      packageTarball: AGNIX_NPM_TARBALL,
      packageFileSha256: AGNIX_PACKAGE_FILE_SHA256,
      commandPathInPackage: "bin/agnix",
      binaryPathInPackage: "bin/agnix-binary",
      binarySha256: AGNIX_BINARY_SHA256,
    },
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
